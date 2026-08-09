import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// .env 를 "패키지 루트"(dist/ 의 상위)에서 로드합니다.
// 이렇게 하면 Claude Desktop 이 어느 위치에서 실행하든 nhplug-mcp/.env 를 찾습니다.
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, "..", ".env") });
// 현재 작업 폴더에 .env 가 있으면 그것도 병합(있을 때만)
dotenv.config();

export interface Config {
  appKey: string;
  appSecret: string;
  baseUrl: string;
  authUrl: string;
  enableTrading: boolean;
  defaultAccount: string;
}

function required(name: string, value: string | undefined): string {
  if (!value || value.trim() === "") {
    throw new Error(
      `환경변수 ${name} 가 설정되지 않았습니다. nhplug-mcp/.env 또는 MCP 설정의 env 에 값을 넣어주세요.`
    );
  }
  return value.trim();
}

// 🔒 앱키·시크릿이 나가는 URL 은 반드시 검증한다.
//    검증이 없으면 오타 한 글자로 자격증명이 엉뚱한 서버에 전송되거나,
//    모의투자로 알고 설정한 주소가 운영이라 실주문이 체결될 수 있다.
//    ⚠️ 호스트를 늘릴 때는 .env.example·README·SDK nhplug/auth.py 도 함께 고칠 것.
const ALLOWED_HOSTS = [
  "api.nhplug.com",     // 🔴 나무 운영 — 주문이 실제 체결됨
  "moapi.nhplug.com",   // 🟢 나무 모의투자
  "api.n2plug.com",     // 🔴 N2 운영 — 주문이 실제 체결됨
  "moapi.n2plug.com",   // 🟢 N2 모의투자
];
const ALLOW_HOSTS_VAR = "NHPLUG_ALLOW_HOSTS";

function allowedHosts(): string[] {
  const extra = (process.env[ALLOW_HOSTS_VAR] ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0);
  return [...ALLOWED_HOSTS, ...extra];
}

/**
 * 자격증명이 나가는 URL 을 검증하고 정규화한다(끝 슬래시 제거).
 * 포트는 검사하지 않는다 — 포트 오타는 접속 실패로 즉시 드러나지만,
 * 호스트 오타는 자격증명이 그대로 전송된 뒤에야 드러나기 때문이다.
 */
function validateUrl(raw: string, name: string): string {
  const u = raw.trim().replace(/\/+$/, "");
  if (u === "") {
    throw new Error(`${name} 가 비어 있습니다. 예: https://api.nhplug.com:8443`);
  }
  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    throw new Error(`${name} 가 올바른 URL 이 아닙니다: ${u}\n  예: https://api.nhplug.com:8443`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`${name} 는 https 여야 합니다 — 앱키·시크릿이 평문으로 전송됩니다: ${u}`);
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    throw new Error(
      `${name} 에는 경로를 넣지 마세요(호스트까지만): ${u}\n  예: https://api.nhplug.com:8443`
    );
  }
  const host = parsed.hostname.toLowerCase();
  const hosts = allowedHosts();
  if (!hosts.includes(host)) {
    throw new Error(
      `${name} 의 호스트 '${host}' 는 허용되지 않습니다.\n` +
        `  허용: ${hosts.join(", ")}\n` +
        `  사내 검증 서버라면 ${ALLOW_HOSTS_VAR} 에 추가하세요 (예: ${ALLOW_HOSTS_VAR}=stg.example.com).`
    );
  }
  return u;
}

export function loadConfig(): Config {
  const enable = (process.env.NHPLUG_ENABLE_TRADING ?? "false").trim().toLowerCase();
  return {
    // NHPLUG_ 접두 변수를 우선 사용하되, 접두 없는 APP_KEY/APP_SECRET 도 허용
    appKey: required("NHPLUG_APP_KEY", process.env.NHPLUG_APP_KEY ?? process.env.APP_KEY),
    appSecret: required(
      "NHPLUG_APP_SECRET",
      process.env.NHPLUG_APP_SECRET ?? process.env.APP_SECRET
    ),
    // 호출 대상. 기본 운영(api). 교육·시뮬레이션은 moapi 로 설정.
    // 허용 호스트가 아니면 서버 기동 시점에 막는다(호출 전에 실패).
    baseUrl: validateUrl(
      process.env.NHPLUG_BASE_URL ?? "https://api.nhplug.com:8443",
      "NHPLUG_BASE_URL"
    ),
    // 토큰(/oauth2/token)은 운영(api) 전용 — moapi 미제공. 호출 대상과 무관하게 항상 api 로 발급.
    authUrl: validateUrl(
      process.env.NHPLUG_AUTH_URL ?? "https://api.nhplug.com:8443",
      "NHPLUG_AUTH_URL"
    ),
    enableTrading: enable === "true" || enable === "1" || enable === "yes",
    defaultAccount: (process.env.NHPLUG_DEFAULT_ACCOUNT ?? "").trim(),
  };
}
