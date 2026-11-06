#!/usr/bin/env node
// 주문 테스트 스크립트 (사람이 직접 실행). 모의투자 환경 검증용.
//
// 사용법:
//   node scripts/order_test.mjs --account 20101036881 --code 005930 --qty 1 --price 70000 --confirm
//   node scripts/order_test.mjs --account 20101036881 --code 005930 --qty 1 --market   (시장가)
//
// --confirm 없이 실행하면 실제 전송 없이 payload 만 출력(드라이런).
// .env 의 NHPLUG_APP_KEY / NHPLUG_APP_SECRET / NHPLUG_BASE_URL 사용.

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
  } catch {}
  return env;
}

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith("--")) {
      const key = t.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) a[key] = true;
      else { a[key] = next; i++; }
    }
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = loadEnv();
  const appKey = env.NHPLUG_APP_KEY || env.APP_KEY;
  const appSecret = env.NHPLUG_APP_SECRET || env.APP_SECRET;
  const baseUrl = env.NHPLUG_BASE_URL || "https://api.nhplug.com:8443";
  const authUrl = env.NHPLUG_AUTH_URL || "https://api.nhplug.com:8443"; // 토큰은 운영(api) 전용

  if (!appKey || !appSecret) { console.error("✗ .env 에 APP_KEY/APP_SECRET 없음"); process.exit(1); }
  if (!args.account || !args.code || !args.qty) {
    console.error("사용법: node scripts/order_test.mjs --account <계좌> --code <종목6자리> --qty <수량> [--price <원>] [--market] [--confirm]");
    process.exit(1);
  }

  const isMarket = !!args.market || !args.price;   // 가격 없으면 시장가
  const input = {
    act_no: String(args.account),
    iem_cd: String(args.code),          // 6자리 그대로 (A 없음)
    orr_qty: Number(args.qty),
    nmn_pr_tp_cd: isMarket ? "05" : "01", // 05 시장가 / 01 지정가
    orr_cnd_dit_cd: "00",                // 없음
    ssl_nmn_pr_dit_cd: "00",             // 정상
    rmt_mkt_cd: String(args.market && args.market !== true ? args.market : "KRX"),
    sor_mkt_sli_yn: "N",
  };
  if (!isMarket) input.orr_pr = Number(args.price); // 원 단위 정수 그대로

  console.log("· baseUrl =", baseUrl);
  if (/\/\/api\.nhplug\.com/.test(baseUrl)) {
    console.log("⚠️  운영 실거래(api.nhplug.com) 환경입니다. 실제 주문이 체결됩니다!");
  }
  console.log("· 주문 payload:", JSON.stringify({ Input_0: input }, null, 2));

  if (!args.confirm) {
    console.log("\n(드라이런) 실제 전송하려면 --confirm 을 붙이세요.");
    return;
  }

  // 1) 토큰
  const tUrl = new URL(`${authUrl}/oauth2/token`);
  tUrl.searchParams.set("appkey", appKey);
  tUrl.searchParams.set("appsecretkey", appSecret);
  tUrl.searchParams.set("grant_type", "client_credentials");
  tUrl.searchParams.set("scope", "oob");
  const tRes = await fetch(tUrl.toString(), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" } });
  const tJson = JSON.parse(await tRes.text());
  const token = tJson.access_token;
  if (!token) { console.error("✗ 토큰 발급 실패:", tJson); process.exit(1); }

  // 2) 매수 주문
  const oRes = await fetch(`${baseUrl}/krstock/order/v1/cashBuy`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=UTF-8",
    },
    body: JSON.stringify({ Input_0: input }),
  });
  const text = await oRes.text();
  console.log(`\n· HTTP ${oRes.status}`);
  try {
    const j = JSON.parse(text);
    console.log("· rsp_cd :", j.rsp_cd, "|", j.rsp_msg);
    console.log("· Output_0:", JSON.stringify(j.Output_0, null, 2));
  } catch {
    console.log("· 응답(raw):", text.slice(0, 800));
  }
}

main().catch((e) => { console.error("✗ 실패:", e.message || e); process.exit(1); });
