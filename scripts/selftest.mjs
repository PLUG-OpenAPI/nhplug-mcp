#!/usr/bin/env node
// 로컬 검증 스크립트 (당신 PC 등 API 서버 접근 가능한 환경에서 실행).
//   node scripts/selftest.mjs
// .env 의 NHPLUG_APP_KEY / NHPLUG_APP_SECRET / NHPLUG_BASE_URL 을 사용합니다.
// 토큰 발급 → 현재가 조회(삼성전자 005930) 까지 실제 호출로 확인합니다.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  const env = { ...process.env };
  try {
    const raw = readFileSync(join(__dirname, "..", ".env"), "utf-8");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    /* .env 없으면 process.env 만 사용 */
  }
  return env;
}

async function main() {
  const env = loadEnv();
  const appKey = env.NHPLUG_APP_KEY || env.APP_KEY;
  const appSecret = env.NHPLUG_APP_SECRET || env.APP_SECRET;
  const baseUrl = env.NHPLUG_BASE_URL || "https://api.nhplug.com:8443";
  const authUrl = env.NHPLUG_AUTH_URL || "https://api.nhplug.com:8443"; // 토큰은 운영(api) 전용

  if (!appKey || !appSecret) {
    console.error("✗ .env 에 NHPLUG_APP_KEY / NHPLUG_APP_SECRET 이 없습니다.");
    process.exit(1);
  }
  console.log(`· baseUrl = ${baseUrl}`);

  // 1) 토큰 발급
  const tokenUrl = new URL(`${authUrl}/oauth2/token`);
  tokenUrl.searchParams.set("appkey", appKey);
  tokenUrl.searchParams.set("appsecretkey", appSecret);
  tokenUrl.searchParams.set("grant_type", "client_credentials");
  tokenUrl.searchParams.set("scope", "oob");

  console.log("· 토큰 발급 요청...");
  const tRes = await fetch(tokenUrl.toString(), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  const tText = await tRes.text();
  if (!tRes.ok) {
    console.error(`✗ 토큰 발급 실패 (HTTP ${tRes.status}): ${tText.slice(0, 400)}`);
    process.exit(1);
  }
  const token = JSON.parse(tText).access_token;
  if (!token) {
    console.error(`✗ access_token 없음: ${tText.slice(0, 400)}`);
    process.exit(1);
  }
  console.log("✓ 토큰 발급 성공"); // 토큰 값은 일부라도 출력하지 않습니다

  // 2) 현재가 조회
  console.log("· 현재가 조회 (005930 삼성전자)...");
  const pRes = await fetch(`${baseUrl}/krstock/quote/v1/currentPrice`, {
    method: "POST",
    headers: {
      "x-client-id": appKey,
      "x-client-secret": appSecret,
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=UTF-8",
    },
    body: JSON.stringify({ Input_0: { iem_cd: "005930", market_cd: "KRX" } }),
  });
  const pText = await pRes.text();
  if (!pRes.ok) {
    console.error(`✗ 현재가 조회 실패 (HTTP ${pRes.status}): ${pText.slice(0, 400)}`);
    process.exit(1);
  }
  const data = JSON.parse(pText);

  // HTTP 200 이어도 업무 성공이 아닐 수 있다 — rsp_cd 를 반드시 판정한다.
  // allowlist(라이브 확인분) + "완료" 메시지 안전망. src/client.ts 의 isSuccess 와 동일 규칙.
  const SUCCESS = new Set(
    (process.env.NHPLUG_SUCCESS_CODES ?? "00000,00166,00221,13578").split(",").map((c) => c.trim())
  );
  const rspCd = data.rsp_cd != null ? String(data.rsp_cd) : undefined;
  const okBiz =
    rspCd === undefined || SUCCESS.has(rspCd) || String(data.rsp_msg ?? "").includes("완료");
  if (!okBiz) {
    console.error(`✗ 업무 오류: rsp_cd=${rspCd} ${data.rsp_msg ?? ""}`);
    process.exit(1);
  }

  // 단건 조회 응답이 배열/객체 어느 쪽이든 안전하게 처리
  const raw = data.Output_0;
  const o0 = Array.isArray(raw) ? raw[0] : raw;
  if (!o0 || o0.stck_prpr == null) {
    console.error(`✗ 현재가 데이터가 비어 있습니다 (rsp_cd=${rspCd ?? "-"}). 응답: ${pText.slice(0, 300)}`);
    process.exit(1);
  }
  console.log(`✓ 현재가 조회 성공: ${o0.iem_nm ?? ""} 현재가 ${o0.stck_prpr}`);
  console.log("\n전체 검증 통과 ✅  MCP 서버를 Claude 에 연결해 사용할 수 있습니다.");
}

main().catch((e) => {
  console.error("✗ 검증 실패:", e.message || e);
  process.exit(1);
});
