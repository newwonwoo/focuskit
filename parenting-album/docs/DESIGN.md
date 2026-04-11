# 원우 앨범봇 — 개발 설계서 (v0.1)

> 카카오톡 → AI 감성 요약 → Notion 적재 → 인쇄용 PDF 자동 생성
> **목표 서버 유지비: ₩0 / 월** (인쇄비 제외)

---

## 0. 문서 목적

본 문서는 "원우 앨범봇" 파이프라인을 Zero-Cost 스택으로 구축하기 위한 실행 설계서다.
코드 작성 전에 아키텍처 결정, 비용 경계, 장애 시나리오, 운영 루틴을 합의하는 것이 목적이다.

작성 시점: 2026-04-11
대상 브랜치: `claude/parenting-album-automation-b4j2w`
프로젝트 루트: `/parenting-album/`

---

## 1. 비기능 요구사항 (NFR)

| 항목 | 목표 | 측정 방법 |
|---|---|---|
| 월 고정비 | ₩0 | 모든 외부 서비스가 Free Tier 한도 내 |
| 1회 수집 응답 시간 | ≤ 3초 (카톡 챗봇 UX) | Webhook → 사용자에게 "저장 완료" 응답까지 |
| 주간 배치 성공률 | ≥ 99% | Cron 실패 시 재시도 + 알림 |
| 사진 손실률 | 0% | 원본 Cloudinary 보관 + Notion URL 이중 기록 |
| 복원력 | 단일 의존성 장애 시 수동 복구 가능 | 모든 로직은 idempotent하게 작성 |

---

## 2. 아키텍처 — 확정안 (수정 제안 반영)

```
┌─────────────────┐
│ 카카오톡 채널    │  (사용자: 아빠 / 엄마)
│ "원우 앨범봇"    │
└────────┬────────┘
         │ (1) 사진 + 텍스트 전송
         ▼
┌────────────────────────┐
│  Kakao i OpenBuilder   │  Webhook (JSON POST)
└────────┬───────────────┘
         │
         ▼
┌──────────────────────────────┐
│  Vercel Serverless Function  │     ← Phase 1: 수집
│  POST /api/kakao/webhook     │
│  (Node.js 20, < 3s 응답)      │
└────┬──────────────┬──────────┘
     │              │
     │ 이미지        │ 레코드
     ▼              ▼
┌──────────┐  ┌──────────────┐
│Cloudinary│  │  Notion DB   │
│(원본+썸네일)│  │ (Raw_Entry) │
└──────────┘  └──────┬───────┘
                     │
                     │ 일요일 22:00 KST
                     ▼
┌────────────────────────────────┐
│  GitHub Actions (Weekly Cron)   │   ← Phase 2: 요약
│  .github/workflows/weekly-ai.yml│
│  → Gemini 1.5 Flash API         │
│  → Notion Update                │
└────────────────────┬───────────┘
                     │
                     │ 수동 트리거 (월 1회 등)
                     ▼
┌────────────────────────────────┐
│  로컬 Node.js 스크립트 (npm run │  ← Phase 3: PDF
│  build:pdf)                     │
│  Notion Fetch → Handlebars →    │
│  Puppeteer → PDF (A5, 300DPI)  │
└─────────────────────────────────┘
```

---

## 3. 최적화 제안 (승인 요청)

> 원안과 다른 부분에 대해 **이유와 트레이드오프**를 제시합니다.
> ✅/❌ 로 승인 여부만 알려주시면 반영하겠습니다.

### 제안 A. 주간 Cron: Vercel Cron → **GitHub Actions**로 변경
**왜:**
- Vercel Hobby 플랜 Cron은 "일 1회"까지만 무료 (주 단위는 하루 1회 돌려서 요일 체크해야 함).
- GitHub Actions는 Public/Private 모두 월 2000분 무료, cron 제한 없음, 타임아웃 6시간.
- 배치 중 Gemini 응답 지연(수십 초)이 발생해도 Vercel 서버리스 타임아웃(Hobby 10초)과 무관.
- 실행 로그가 GitHub UI에 남아 디버깅/재실행이 쉬움.

**트레이드오프:** Workflow 파일 관리 필요 (1개 파일), GH Secrets에 API 키 추가 필요.

**승인:** [ ] A

---

### 제안 B. 카톡 Webhook 응답 전략: **2-Phase 응답(즉시 ACK + 후처리)**
**왜:**
- 카카오 i OpenBuilder는 응답 지연 시 사용자에게 "챗봇이 응답하지 않습니다"가 노출됨 (기본 5초 컷).
- Cloudinary 업로드(1~3초) + Notion Insert(0.5~1초)가 겹치면 타임아웃 리스크.
- Kakao의 **Callback(AI 챗봇 v2 콜백) 기능**을 사용해 즉시 "저장 중..." 응답 → 백엔드에서 처리 완료 후 최종 결과를 콜백으로 push.

**트레이드오프:** OpenBuilder 스킬에서 "사용 설정 - 콜백" ON 필요, 구현 복잡도 소폭 증가.

**대안:** 콜백이 부담스럽다면 → Vercel Function에서 `waitUntil()` 패턴으로 background task 처리 후 즉시 응답.

**승인:** [ ] B-1 (콜백 사용) / [ ] B-2 (waitUntil 패턴)

---

### 제안 C. 이미지 파이프라인: **Cloudinary Upload Preset + eager transformation**
**왜:**
- 카카오에서 넘어오는 이미지 URL은 **24시간 이후 만료**됨. 반드시 즉시 복사 필요.
- 원본 1장 + 인쇄용 3000px + 썸네일 400px를 `eager` 옵션으로 한 번에 생성 → API 호출 1회.
- 자동 포맷 변환(`f_auto`) + 자동 품질(`q_auto`)로 무료 크레딧 절약.

**트레이드오프:** 없음. 승인만 필요.

**승인:** [ ] C

---

### 제안 D. PDF 인쇄 품질: **CMYK 변환은 로컬에서 Ghostscript 후처리**
**왜:**
- Puppeteer가 출력하는 PDF는 **sRGB**. 포토북 업체 대부분은 RGB로도 받지만, 색 재현 정확도를 원한다면 CMYK 변환 필요.
- 로컬에 Ghostscript 설치 후 `gs -sDEVICE=pdfwrite -sProcessColorModel=DeviceCMYK ...` 로 변환.
- 선택 사항: `npm run build:pdf` 는 RGB PDF, `npm run build:pdf:cmyk` 는 CMYK 변환까지 수행.

**트레이드오프:** Ghostscript 로컬 설치 필요(무료, brew/apt 한 줄).

**승인:** [ ] D (원우 아빠가 사용할 포토북 업체 기준으로 결정)

---

### 제안 E. 보안: **Webhook 시크릿 검증 + 화자 화이트리스트**
**왜:**
- 카카오 i OpenBuilder Webhook은 공개 URL이라 누구나 호출 가능. 쓰레기 데이터 주입 리스크.
- 해결책:
  1. Vercel 환경변수 `KAKAO_WEBHOOK_SECRET`를 URL 쿼리파라미터로 전달 + 검증.
  2. 추가로 `userRequest.user.id` 화이트리스트(아빠/엄마 2명만 허용).
- 외부 공격뿐 아니라 **실수로 다른 사람이 앨범봇을 친구 추가해 장난치는 것**도 차단.

**트레이드오프:** 없음. 승인만 필요.

**승인:** [ ] E

---

## 4. 데이터 플로우 상세

### Phase 1 — 수집 (실시간)

**Trigger:** 카카오톡 채팅방에 사진 또는 텍스트 전송

**Step-by-step:**
1. Kakao OpenBuilder → `POST https://<vercel>.vercel.app/api/kakao/webhook?secret=xxx`
2. Vercel Function (`api/kakao/webhook.js`):
   - 스키마 검증 (JSON zod/ajv)
   - 시크릿 및 사용자 ID 검증 (제안 E)
   - `userRequest.params` 또는 `action.params`에서 이미지 URL 추출
   - **즉시 응답**: "원우 기록 저장 중이야 📸" (제안 B)
3. Background task (`waitUntil` 또는 콜백):
   - Kakao 임시 이미지 URL → `fetch` → Buffer
   - Cloudinary `upload_stream` (제안 C의 eager 옵션)
   - Notion `pages.create` → `Raw_Entry` DB에 row 생성
   - 성공/실패를 콜백 or 로그로 기록
4. Idempotency: `userRequest.block.id + timestamp` 를 해시해 Notion `ID` 컬럼에 저장. 중복 시 skip.

### Phase 2 — 주간 AI 요약 (배치)

**Trigger:** 매주 일요일 22:00 KST (= UTC 13:00) / 수동 `workflow_dispatch` 가능

**Step-by-step:**
1. GitHub Actions runner 기동 (Ubuntu-latest)
2. Node.js 스크립트 `scripts/weekly-summarize.mjs` 실행
3. Notion DB에서 `Status = Draft` 이고 `Date >= now-7d` 인 레코드 fetch
4. 날짜별로 그룹화 → Gemini 1.5 Flash 호출 (아래 프롬프트 참조)
5. 반환된 제목/에세이를 각 Notion row의 `AI_Summary` + `Week_Title`에 update, `Status = Summarized`
6. 실패 시 지수 백오프 3회 재시도. 최종 실패는 GitHub Actions 로그 + Notion `Error_Log` DB에 기록

**Gemini 프롬프트 (초안):**
```
당신은 24개월 아이 "원우"의 성장 기록을 다듬는 따뜻한 관찰자입니다.

아래는 일주일간 아빠/엄마가 카톡으로 남긴 파편화된 메모와 사진 설명입니다.
이것을 바탕으로 다음을 생성해주세요:

1. 이번 주 제목: 아이의 핵심 변화나 사건을 담은 10자 내외의 감성적 제목
2. 주간 에세이: 3~4문장의 짧은 에세이. 과장 없이, 담백하고 따뜻하게.
3. 각 사진별 캡션: 사진 설명 옆에 붙일 한 문장 (15자 내외)

제약:
- 존재하지 않는 사실을 추가하지 마세요.
- 이모지는 사용하지 마세요.
- "사랑스러운", "너무나" 같은 상투적 수식어는 피해주세요.

입력 데이터:
{entries}

출력은 반드시 JSON 형식으로:
{
  "week_title": "...",
  "essay": "...",
  "captions": [{"entry_id": "...", "caption": "..."}]
}
```

### Phase 3 — 로컬 PDF 렌더링 (수동)

**Trigger:** 사용자가 로컬 PC에서 `npm run build:pdf` 실행

**Step-by-step:**
1. Notion DB에서 `Status = Summarized` 전체 fetch
2. 주차별로 그룹화 → Handlebars 템플릿(`templates/album.hbs`)에 주입
3. Puppeteer launch → `page.setContent(html)` → `page.pdf({format: 'A5', printBackground: true})`
4. 출력물: `dist/wonwoo-album-YYYYMM.pdf`
5. (선택, 제안 D) Ghostscript로 CMYK 변환 → `dist/wonwoo-album-YYYYMM-cmyk.pdf`
6. 성공 시 해당 레코드들 `Status = Printed` 로 업데이트

---

## 5. 데이터베이스 스키마 (Notion)

### DB 1: `Raw_Entry` (원본 기록)

| 컬럼 | 타입 | 설명 |
|---|---|---|
| `ID` | Title | `{yyyyMMddHHmmss}_{userShort}` (idempotency key) |
| `Date` | Date | 메시지 수신 시각 (KST) |
| `Type` | Select | `Text` / `Image` / `Mixed` |
| `Raw_Content` | Rich Text | 원본 메시지 |
| `Author` | Select | `아빠` / `엄마` |
| `Media_URL` | URL | Cloudinary 원본 |
| `Media_Print_URL` | URL | Cloudinary 3000px (인쇄용) |
| `Media_Thumb_URL` | URL | Cloudinary 400px (미리보기) |
| `AI_Caption` | Rich Text | Phase 2에서 생성 |
| `Status` | Status | `Draft` → `Summarized` → `Printed` |
| `Week_Ref` | Relation | → `Weekly_Summary` DB |
| `Error_Log` | Rich Text | 에러 발생 시 메시지 |

### DB 2: `Weekly_Summary` (주간 요약)

| 컬럼 | 타입 | 설명 |
|---|---|---|
| `Week_ID` | Title | `2026-W15` (ISO week) |
| `Start_Date` | Date | 해당 주 월요일 |
| `Week_Title` | Rich Text | Gemini 생성 제목 |
| `Essay` | Rich Text | Gemini 생성 에세이 |
| `Entry_Count` | Number | 포함된 원본 레코드 수 |
| `Status` | Status | `Pending` → `Summarized` → `Printed` |

---

## 6. 디렉토리 구조 (계획)

```
parenting-album/
├── docs/
│   └── DESIGN.md               ← 본 문서
├── api/
│   └── kakao/
│       └── webhook.js          ← Phase 1: Vercel Serverless
├── scripts/
│   ├── weekly-summarize.mjs    ← Phase 2: GitHub Actions용
│   └── build-pdf.mjs           ← Phase 3: 로컬용
├── templates/
│   ├── album.hbs               ← Handlebars 템플릿
│   └── album.css               ← 인쇄용 CSS (A5, page-break, font-embed)
├── lib/
│   ├── notion.js               ← Notion 클라이언트 래퍼
│   ├── cloudinary.js           ← 업로드 헬퍼
│   ├── gemini.js               ← 프롬프트 + 호출
│   └── kakao.js                ← 카카오 응답 포맷 헬퍼
├── .github/
│   └── workflows/
│       └── weekly-ai.yml       ← Phase 2 Cron
├── package.json
├── vercel.json
└── .env.example                ← 필요 환경변수 목록
```

---

## 7. 환경변수 / 시크릿

| 키 | 저장소 | 용도 |
|---|---|---|
| `KAKAO_WEBHOOK_SECRET` | Vercel Env | Phase 1 검증 |
| `KAKAO_ALLOWED_USER_IDS` | Vercel Env | 화이트리스트(콤마 구분) |
| `NOTION_TOKEN` | Vercel + GH Secret | Notion API |
| `NOTION_DB_RAW_ID` | Vercel + GH Secret | Raw_Entry DB |
| `NOTION_DB_WEEKLY_ID` | GH Secret + 로컬 | Weekly_Summary DB |
| `CLOUDINARY_CLOUD_NAME` | Vercel Env | - |
| `CLOUDINARY_API_KEY` | Vercel Env | - |
| `CLOUDINARY_API_SECRET` | Vercel Env | - |
| `GEMINI_API_KEY` | GH Secret | Phase 2 전용 |

---

## 8. Free Tier 한도 점검

| 서비스 | 한도 | 예상 사용량 (월) | 여유 |
|---|---|---|---|
| Vercel Hobby | 100GB-Hr, 100k req | ~3000 req, <1GB-Hr | ✅ 충분 |
| Notion API | 무제한, 3 req/s | ~200 req/일 | ✅ 충분 |
| Cloudinary | 25 credits (~25GB 저장+변환) | ~2GB | ✅ 충분 |
| Gemini 1.5 Flash | 15 RPM, 1500 RPD | ~5 req/주 | ✅ 충분 |
| GitHub Actions | 2000분/월 | ~5분/주 | ✅ 충분 |

> **결론**: 아이가 10명이 되어도 Free Tier 안에서 동작함.

---

## 9. 장애 시나리오 & 대응

| 시나리오 | 영향 | 대응 |
|---|---|---|
| Kakao 이미지 URL 만료 (24h) | 사진 유실 | Phase 1에서 **즉시** Cloudinary로 복사 (지연 금지) |
| Cloudinary 업로드 실패 | 레코드 불완전 | Notion에 `Status=Error`로 기록, 매일 재시도 스크립트 |
| Notion API rate limit | Phase 1 실패 | 지수 백오프 3회, 실패 시 Vercel 로그 + Slack/메일 |
| Gemini 쿼터 초과 | 주간 요약 실패 | 다음 주 배치가 2주치 처리 (누적 복구) |
| Vercel 서버리스 타임아웃 | 일부 유실 | 제안 B의 콜백/waitUntil 패턴으로 회피 |
| GitHub Actions Cron 누락 | 1주 지연 | `workflow_dispatch`로 수동 재실행 |

---

## 10. 구현 순서 (Action Plan)

합의 후 아래 순서대로 PR 단위 커밋:

1. **Step 0 — 프로젝트 스캐폴딩**
   - `parenting-album/package.json`, `vercel.json`, `.env.example`, `.gitignore`
   - 기본 디렉토리 구조 생성

2. **Step 1 — Phase 1 (Webhook)**
   - `lib/notion.js`, `lib/cloudinary.js`, `lib/kakao.js`
   - `api/kakao/webhook.js`
   - 로컬 테스트: `curl` 로 fake Kakao payload POST

3. **Step 2 — Phase 2 (AI 요약)**
   - `lib/gemini.js`
   - `scripts/weekly-summarize.mjs`
   - `.github/workflows/weekly-ai.yml`
   - 로컬 테스트: `node scripts/weekly-summarize.mjs --dry-run`

4. **Step 3 — Phase 3 (PDF)**
   - `templates/album.hbs`, `templates/album.css`
   - `scripts/build-pdf.mjs`
   - (선택) Ghostscript CMYK 스크립트

5. **Step 4 — 운영 문서**
   - `parenting-album/README.md`: 설치/배포/운영 가이드
   - Notion DB 템플릿 복제 링크

---

## 11. 미결정 사항 (사용자 입력 필요)

작업 시작 전에 아래 항목에 답해주시면 반영하겠습니다:

1. **언어 선택**: Node.js(JavaScript/TypeScript) vs Python?
   → 추천: **Node.js (TypeScript)** — Puppeteer, Handlebars, Vercel SDK가 JS 생태계에 더 성숙.

2. **포토북 업체**: 어디를 쓰실 예정인가요? (스냅스 / 퍼블로토 / 레드프린팅 등)
   → 업체별 PDF 사양(색공간, 재단선, 해상도)이 달라 Phase 3 CSS에 반영 필요.

3. **앨범 주기**: 월 1권 / 분기 1권 / 반년 1권?
   → Phase 3 `build-pdf` 스크립트의 기본 필터 범위에 반영.

4. **폰트**: 인쇄 품질의 80%는 폰트입니다. 제안:
   - 본문: Pretendard (무료, 상업용 OK) 또는 리디바탕체
   - 제목: 교보손글씨 / 마루부리 (무료)
   → 선호하시는 폰트 있으시면 알려주세요.

5. **카카오 i OpenBuilder 계정**: 이미 개설되어 있나요?
   → 없다면 먼저 채널 + 챗봇 생성 가이드부터 작성해드릴 수 있습니다.

6. **제안 A~E 승인 여부**: 위 §3 섹션의 체크박스.

---

## 12. 범위 밖 (v0.1에서 하지 않는 것)

- 음성 메모 → 텍스트 변환 (Whisper 등)
- 다중 아이 지원 (지금은 원우 1명만)
- 웹 대시보드 (Notion UI로 충분)
- 자동 포토북 주문 API 연동
- 앨범 공유 링크 (가족 열람)

> 위 항목들은 v0.2 이후로 이관.

---

**끝. 승인 후 Step 0(스캐폴딩)부터 진행합니다.**
