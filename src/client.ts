import type { Config } from "./config.js";
import { getAccessToken, clearTokenCache } from "./auth.js";

/** 업무 성공으로 간주하는 rsp_cd. NHPLUG_SUCCESS_CODES 로 확장 가능. */
export function successCodes(): Set<string> {
  const env = process.env.NHPLUG_SUCCESS_CODES;
  if (env) return new Set(env.split(",").map((c) => c.trim()).filter(Boolean));
  return new Set(["00000", "00166"]);
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

/** 호출 실패(HTTP 오류 또는 업무 오류)를 표현하는 구조화 오류. */
export class NhplugApiError extends Error {
  constructor(
    message: string,
    public readonly detail: {
      category: "auth" | "rate_limit" | "business" | "network" | "http";
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
 *   - **HTTP 200 이어도 rsp_cd 가 성공 코드가 아니면 업무 오류로 예외 발생**
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
  const rspCd: string | undefined = data?.rsp_cd != null ? String(data.rsp_cd) : undefined;
  const rspMsg: string | undefined = data?.rsp_msg;

  // ---- HTTP 오류 ----
  if (!res!.ok) {
    if (res!.status === 429) {
      const ra = res!.headers.get("Retry-After");
      throw new NhplugApiError(rspMsg ?? "호출 유량을 초과했습니다. 호출 간격을 늘리세요.", {
        category: "rate_limit", code: rspCd ?? "IGW42902", status: 429, path,
        retryable: true, retryAfterMs: ra ? Math.round(Number(ra) * 1000) : undefined,
        environment: config.baseUrl, raw: data,
      });
    }
    if (isInvalidTokenError(res!.status, text)) {
      throw new NhplugApiError(rspMsg ?? "인증 실패(토큰 무효).", {
        category: "auth", code: rspCd, status: res!.status, path,
        retryable: false, environment: config.baseUrl, raw: data,
      });
    }
    throw new NhplugApiError(rspMsg ?? `HTTP ${res!.status}: ${text.slice(0, 300)}`, {
      category: "http", code: rspCd, status: res!.status, path,
      retryable: false, environment: config.baseUrl, raw: data,
    });
  }

  // ---- HTTP 200 이지만 업무 오류(rsp_cd) ----
  if (rspCd !== undefined && !successCodes().has(rspCd)) {
    throw new NhplugApiError(rspMsg ?? "업무 오류", {
      category: "business", code: rspCd, status: 200, path,
      retryable: false, environment: config.baseUrl, raw: data,
    });
  }

  return data;
}
