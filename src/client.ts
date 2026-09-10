import type { Config } from "./config.js";
import { getAccessToken, clearTokenCache } from "./auth.js";

/**
 * 오류 응답에서 (코드, 메시지)를 꺼낸다 — 업무/게이트웨이 두 서식을 모두 본다.
 *   업무 계층    rsp_cd · rsp_msg
 *   게이트웨이   error_code · error_description   (예: IGW40031 유효하지 않은 AppKey)
 * 둘 다 없으면 본문 원문을 메시지로 쓴다. 서버가 보낸 말을 잃지 않기 위해서다.
 *
 * 🔴 이 함수는 **판정하지 않는다.** 꺼내 줄 뿐이다.
 */
export function serverMessage(data: any): { code?: string; message?: string } {
  if (data === null || typeof data !== "object") {
    const text = String(data ?? "").trim();
    return { message: text.slice(0, 500) || undefined };
  }
  const code = data.rsp_cd ?? data.error_code;
  let message = data.rsp_msg ?? data.error_description ?? data.error;
  if (message === undefined && code === undefined) {
    message = JSON.stringify(data).slice(0, 500);
  }
  return { code: code === undefined ? undefined : String(code), message };
}

/**
 * 토큰 무효 신호만 좁게 판별(재발급 후 재시도 대상).
 * IGW40043("유효하지 않은 token") 또는 HTTP 401 만 해당.
 * 일반 400(예: IGW40024)·429(유량 초과)는 재시도하지 않는다.
 */
function isInvalidTokenError(status: number, body: string): boolean {
  if (status === 401) return true;
  return body.includes("IGW40043") || /유효하지\s*않은\s*token/i.test(body);
}

/** 호출 실패(HTTP 200 이 아닌 응답)를 표현하는 구조화 오류. 업무 오류는 여기로 오지 않는다. */
export class NhplugApiError extends Error {
  constructor(
    message: string,
    public readonly detail: {
      // "business" 는 0.4.0 에서 없어졌다 — HTTP 200 응답은 예외가 되지 않는다.
      category: "auth" | "rate_limit" | "network" | "http";
      code?: string;
      status?: number;
      path: string;
      retryable: boolean;
      retryAfterMs?: number;
      environment: string;
      raw?: unknown;
    }
  ) {
    super(message);
    this.name = "NhplugApiError";
  }
}

/**
 * NH Open API REST 호출 공통 래퍼.
 *   - 토큰 자동 발급/캐시, 무효(401/IGW40043)면 재발급 후 1회 재시도
 *   - 429(유량 초과)는 자동 재시도하지 않고 rate_limit 오류로 올림(토큰 재발급 안 함)
 *
 * 🔴 **업무 판정을 하지 않는다.** 기준은 HTTP 상태코드 하나다.
 *     HTTP 200      → 본문을 **그대로** 반환. rsp_cd·rsp_msg 도 손대지 않는다.
 *     HTTP 200 아님 → 본문을 그대로 raw 에 싣고 예외.
 *    같은 rsp_cd 가 API 마다 정상일 수도 오류일 수도 있어 어떤 코드 목록도 기준이 될 수 없다.
 *    성공 여부는 응답을 받는 쪽(모델·사용자)이 rsp_msg 를 읽고 판단한다.
 */
export async function callRest(
  config: Config,
  path: string,
  input: Record<string, unknown>,
  cts?: string
): Promise<any> {
  const url = `${config.baseUrl}${path}`;
  const body = JSON.stringify({ Input_0: input });
  let forceToken = false; // 401 일 때만 true. 429 등에는 절대 재발급하지 않는다.
  let res: Response | undefined;
  let text = "";

  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getAccessToken(config, forceToken);
    const headers: Record<string, string> = {
      "x-client-id": config.appKey,
      "x-client-secret": config.appSecret,
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=UTF-8",
    };
    if (cts) headers["cts"] = cts;

    try {
      res = await fetch(url, { method: "POST", headers, body });
    } catch (e) {
      throw new NhplugApiError(
        `네트워크 오류. ${config.baseUrl} 접근 가능한 환경인지 확인하세요. 원인: ${String(e)}`,
        { category: "network", path, retryable: true, environment: config.baseUrl }
      );
    }

    text = await res.text();
    if (res.ok) break;
    if (attempt === 0 && isInvalidTokenError(res.status, text)) {
      clearTokenCache();
      forceToken = true;
      continue;
    }
    break;
  }

  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  // ---- HTTP 200 아님 → 오류. 본문은 가공하지 않고 raw 에 그대로 싣는다 ----
  if (!res!.ok) {
    const { code, message } = serverMessage(data);
    if (res!.status === 429) {
      const ra = res!.headers.get("Retry-After");
      throw new NhplugApiError(message ?? "호출 유량을 초과했습니다. 호출 간격을 늘리세요.", {
        category: "rate_limit", code: code ?? "IGW42902", status: 429, path,
        retryable: true, retryAfterMs: ra ? Math.round(Number(ra) * 1000) : undefined,
        environment: config.baseUrl, raw: data,
      });
    }
    if (isInvalidTokenError(res!.status, text)) {
      throw new NhplugApiError(message ?? "인증 실패(토큰 무효).", {
        category: "auth", code, status: res!.status, path,
        retryable: false, environment: config.baseUrl, raw: data,
      });
    }
    throw new NhplugApiError(message ?? `HTTP ${res!.status}: ${text.slice(0, 300)}`, {
      category: "http", code, status: res!.status, path,
      retryable: false, environment: config.baseUrl, raw: data,
    });
  }

  // ---- HTTP 200 → 본문 그대로. 업무 판정은 하지 않는다 ----
  //      rsp_cd 를 해석하면 같은 코드가 API 마다 다른 뜻이라 반드시 오판한다.
  //      Output_* 와 rsp_cd·rsp_msg 가 모두 담긴 원본이 모델에게 그대로 전달된다.
  return data;
}
