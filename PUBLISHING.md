# 배포 가이드 (npx 방식)

고객이 `npx` 한 줄로 쓰게 하는 방법은 두 가지입니다. **A(npm 배포)** 를 권장합니다.

---

## 방법 A — npm 레지스트리에 배포 (권장)

고객 명령: `npx @nhplug/mcp-server`
장점: 설치 빠름·안정적, 고객 PC에 빌드 도구 불필요. 버전 관리 쉬움.
필요한 것: npm 계정(무료).

### 준비 (최초 1회)

1. [npmjs.com](https://www.npmjs.com) 가입.
2. 스코프 `@nhplug` 를 쓰려면 npm에서 **Organization "nhplug"** 를 생성하세요(무료, public 패키지).
   - 조직을 안 만들려면 `package.json` 의 `"name"` 을 스코프 없는 이름(예: `"nhplug-mcp-server"`)으로 바꾸면 됩니다. 그 경우 고객 명령은 `npx nhplug-mcp-server`.
3. 터미널에서 로그인: `npm login`

### 배포

```bash
cd nhplug-mcp
npm install
npm run build        # dist 생성 (prepublishOnly 로 자동 실행되기도 함)
npm publish          # 스코프 public 은 package.json 의 publishConfig 로 처리됨
```

### 업데이트 배포

```bash
npm version patch    # 0.1.0 -> 0.1.1 (minor/major 도 가능)
npm publish
```

### 고객이 넣을 Claude Desktop 설정

```json
{
  "mcpServers": {
    "nhplug": {
      "command": "npx",
      "args": ["-y", "@nhplug/mcp-server"],
      "env": {
        "NHPLUG_APP_KEY": "고객_APP_KEY",
        "NHPLUG_APP_SECRET": "고객_APP_SECRET",
        "NHPLUG_BASE_URL": "https://api.nhplug.com:8443",
        "NHPLUG_ENABLE_TRADING": "false"
      }
    }
  }
}
```

> npm 배포판에는 `.env` 가 포함되지 않으므로, 고객은 **키를 위 `env` 블록에 직접** 넣습니다.

---

## 방법 B — GitHub에서 직접 실행 (npm 계정 불필요)

고객 명령: `npx github:PLUG-OpenAPI/nhplug-mcp`
장점: npm 배포 없이 GitHub push 만으로 배포. 당신의 "GitHub 주소" 직감에 가장 가까움.
단점: 고객 PC에서 매 설치 시 소스를 빌드(`prepare` 스크립트) → 첫 실행이 느리고, 고객에 Node 빌드 환경 필요. 안정성은 A보다 낮음.

### 준비

GitHub 저장소(`PLUG-OpenAPI/nhplug-mcp`)에 이 폴더 내용을 push. (`dist/`·`node_modules`·`.env` 는 `.gitignore` 로 제외됨 — 정상. 고객 쪽에서 `prepare` 로 빌드됩니다.)

### 고객 설정

```json
{
  "mcpServers": {
    "nhplug": {
      "command": "npx",
      "args": ["-y", "github:PLUG-OpenAPI/nhplug-mcp"],
      "env": {
        "NHPLUG_APP_KEY": "고객_APP_KEY",
        "NHPLUG_APP_SECRET": "고객_APP_SECRET",
        "NHPLUG_BASE_URL": "https://api.nhplug.com:8443"
      }
    }
  }
}
```

---

## GitHub 저장소는 두 방법 모두에서 만들어 두세요

- 방법 A: GitHub = 소스 공개·이슈·문서. npm = 실제 배포.
- 방법 B: GitHub = 소스 겸 배포처.

### GitHub 최초 push (조직 PLUG-OpenAPI)

```bash
cd nhplug-mcp
git init
git add .
git commit -m "NH Open API local MCP server v0.1.0"
git branch -M main
git remote add origin https://github.com/PLUG-OpenAPI/nhplug-mcp.git
git push -u origin main
```

> `.env`(실제 키)는 `.gitignore` 로 커밋되지 않습니다. push 전에 `git status` 로 `.env` 가 목록에 없는지 꼭 확인하세요.
