import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "./config.js";
import { callRest } from "./client.js";
import { loadOperations, findOperation, listDomains } from "./spec.js";

/** 🔴 이 MCP 는 조회 전용이다 — 주문(매수·매도·정정·취소)은 어떤 설정으로도 실행하지 않는다. */
const ORDER_NOTE =
  "이 MCP 는 주문을 실행하지 않습니다(조회 전용). 주문 API 의 입력 형식은 describe_api 로 확인할 수 있고, " +
  "실제 주문은 nhplug-sdk(https://github.com/PLUG-OpenAPI/nhplug-sdk) 코드로 실행하세요. " +
  "반드시 모의투자(moapi)에서 먼저 검증하세요.";

function textResult(obj: unknown) {
  return {
    content: [
      { type: "text" as const, text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) },
    ],
  };
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: `오류: ${message}` }],
    isError: true,
  };
}

/**
 * 호출 예외를 구조화 오류로 변환.
 * 유량 초과·인증 실패·네트워크 오류를 모델이 구분할 수 있도록 category/code 를 함께 싣는다.
 *
 * 🔴 여기로 오는 것은 **HTTP 200 이 아닌 응답**뿐이다. HTTP 200 이면 업무 결과와 무관하게
 *    본문이 textResult() 로 그대로 전달된다 — rsp_cd·rsp_msg 를 우리가 판정하지 않는다.
 */
function toErrorResult(e: unknown) {
  const d = (e as any)?.detail;
  const msg = e instanceof Error ? e.message : String(e);
  if (d) {
    const info = {
      error: {
        category: d.category, code: d.code, message: msg,
        status: d.status, path: d.path, retryable: d.retryable,
        retry_after_ms: d.retryAfterMs, environment: d.environment,
      },
    };
    return {
      content: [{ type: "text" as const, text: `오류: ${msg}\n${JSON.stringify(info, null, 2)}` }],
      isError: true,
    };
  }
  return errorResult(msg);
}

export function registerTools(server: McpServer, config: Config): void {
  // ── 메타 도구 1: 사용 가능한 API 목록 ────────────────────────────────
  server.tool(
    "list_apis",
    "NH투자증권 Open API 에서 호출 가능한 엔드포인트 목록을 조회합니다. 자산군(domain)·카테고리·키워드로 필터링할 수 있습니다. 먼저 이 도구로 원하는 API 의 operationId 를 찾은 뒤 describe_api / call_api 로 이어가세요. 주문(거래) API 는 서버가 거래 활성화 모드일 때만 표시됩니다.",
    {
      domain: z
        .string()
        .optional()
        .describe("자산군 필터 (예: krstock). 생략 시 전체."),
      category: z
        .string()
        .optional()
        .describe("카테고리 부분일치 (예: 시세, 조회, 주문)."),
      keyword: z
        .string()
        .optional()
        .describe("summary/operationId/path 부분일치 키워드."),
    },
    async ({ domain, category, keyword }) => {
      let ops = loadOperations().filter((o) => !o.isTrading);   // 주문 API 는 실행할 수 없으므로 목록에서 뺀다
      if (domain) ops = ops.filter((o) => o.domain === domain);
      if (category) ops = ops.filter((o) => o.category.includes(category));
      if (keyword) {
        const k = keyword.toLowerCase();
        ops = ops.filter(
          (o) =>
            o.summary.toLowerCase().includes(k) ||
            o.operationId.toLowerCase().includes(k) ||
            o.path.toLowerCase().includes(k)
        );
      }
      const list = ops.map((o) => ({
        operationId: o.operationId,
        summary: o.summary,
        domain: o.domain,
        category: o.category,
        path: o.path,
      }));
      return textResult({
        count: list.length,
        domains: listDomains(),
        apis: list,
        order_apis: {
          hidden_count: loadOperations().filter((o) => o.isTrading).length,
          note: ORDER_NOTE,
        },
      });
    }
  );

  // ── 메타 도구 2: 특정 API 입력 스키마 설명 ───────────────────────────
  server.tool(
    "describe_api",
    "특정 operationId 의 입력 필드(Input_0) 스키마를 반환합니다. call_api 호출 전에 어떤 파라미터가 필요한지 확인하는 용도입니다.",
    {
      operationId: z.string().describe("list_apis 로 찾은 operationId (예: krstockQuoteCurrentPrice)"),
    },
    async ({ operationId }) => {
      const op = findOperation(operationId);
      if (!op) return errorResult(`operationId '${operationId}' 를 찾을 수 없습니다. list_apis 로 확인하세요.`);
      return textResult({
        operationId: op.operationId,
        summary: op.summary,
        domain: op.domain,
        category: op.category,
        method: op.method,
        path: op.path,
        input_fields: op.inputFields,
        note: op.isTrading
          ? ORDER_NOTE
          : "call_api 의 input 인자에 위 필드들을 담아 { 필드명: 값 } 형태로 전달하세요. 응답은 Output_0(및 Output_1 등)로 반환됩니다.",
      });
    }
  );

  // ── 메타 도구 3: 실제 호출 ──────────────────────────────────────────
  server.tool(
    "call_api",
    "operationId 와 입력값으로 NH Open API 를 실제 호출합니다(시세·조회 전용). 인증/헤더/Input_0 봉투는 자동 처리됩니다. 주문(매수·매도·정정·취소) API 는 호출할 수 없습니다.",
    {
      operationId: z.string().describe("호출할 operationId"),
      input: z
        .record(z.string(), z.any())
        .describe("Input_0 에 들어갈 파라미터 객체 (예: { iem_cd: '005930', market_cd: 'KRX' })"),
      cts: z.string().optional().describe("연속조회(페이지네이션) 키. 목록 조회 다음 페이지에 사용."),
    },
    async ({ operationId, input, cts }) => {
      const op = findOperation(operationId);
      if (!op) return errorResult(`operationId '${operationId}' 를 찾을 수 없습니다. list_apis 로 확인하세요.`);
      // 🔴 주문은 어떤 설정으로도 실행하지 않는다(조회 전용 MCP). 우회 스위치를 두지 말 것.
      if (op.isTrading) {
        return errorResult(`'${operationId}' 는 주문 API 입니다. ${ORDER_NOTE}`);
      }
      try {
        const res = await callRest(config, op.path, input ?? {}, cts);
        return textResult(res);
      } catch (e) {
        return toErrorResult(e);
      }
    }
  );

  // ── 단축 도구 1: 국내주식 현재가 ────────────────────────────────────
  server.tool(
    "get_stock_price",
    "국내주식 현재가 시세를 조회합니다. (단축 도구 = call_api 로 krstockQuoteCurrentPrice 를 호출하는 것과 동일)",
    {
      stock_code: z.string().describe("종목코드 6자리 (예: 005930 = 삼성전자)"),
    },
    async ({ stock_code }) => {
      try {
        const res = await callRest(config, "/krstock/quote/v1/currentPrice", {
          iem_cd: stock_code,
          market_cd: "KRX",
        });
        return textResult(res);
      } catch (e) {
        return toErrorResult(e);
      }
    }
  );

  // ── 단축 도구 2: 국내주식 잔고 조회 ─────────────────────────────────
  server.tool(
    "get_stock_balance",
    "국내주식 계좌 잔고를 조회합니다. (단축 도구 = krstockInquiryBalance)",
    {
      account_no: z
        .string()
        .optional()
        .describe("계좌번호. 생략 시 NHPLUG_DEFAULT_ACCOUNT 환경변수 값 사용."),
    },
    async ({ account_no }) => {
      const act = account_no ?? config.defaultAccount;
      if (!act) return errorResult("계좌번호가 없습니다. account_no 를 넘기거나 NHPLUG_DEFAULT_ACCOUNT 를 설정하세요.");
      try {
        const res = await callRest(config, "/krstock/inquiry/v1/balance", {
          act_no: act,
          bnc_bse_cd: "5",
          ltg_aot_dit_cd: "9",
          aet_bse: "2",
          qut_dit_cd: "UNT",
        });
        return textResult(res);
      } catch (e) {
        return toErrorResult(e);
      }
    }
  );

  // ── 단축 도구 3: 계좌 목록 조회 (플랫폼 공통 /n2/acctinfo) ───────────
  server.tool(
    "list_accounts",
    "로그인 자격증명(앱키/시크릿)에 연결된 보유 계좌 목록을 조회합니다. 잔고조회·주문 전에 계좌번호(act_no)를 확보하는 용도입니다. 입력값은 없습니다. (플랫폼 공통 엔드포인트 POST /n2/acctinfo)",
    {},
    async () => {
      try {
        const res = await callRest(config, "/n2/acctinfo", {});
        return textResult(res);
      } catch (e) {
        return toErrorResult(e);
      }
    }
  );
}
