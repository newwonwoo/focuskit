# 원우 앨범봇 (Parenting Album Automation)

카카오톡으로 사진·메모를 보내면 Gemini AI가 따뜻한 에세이로 다듬고, 매월 인쇄용 PDF 앨범을 자동 생성하는 Zero-Cost 파이프라인.

> **목표 서버 유지비: ₩0 / 월** (인쇄비 제외)
> 상세 설계는 [`docs/DESIGN.md`](./docs/DESIGN.md) 참조.

---

## 🏗️ 아키텍처 요약

```
카톡 채널 ──(Webhook)──▶ Vercel Serverless ──▶ Cloudinary + Notion
                                                       │
                           ┌───────────────────────────┘
                           ▼
                    GitHub Actions (주 1회) ──▶ Gemini API ──▶ Notion 업데이트
                           │
                           ▼
              로컬 PC 스크립트 (수동, 월 1회) ──▶ Handlebars + Puppeteer ──▶ PDF
```

## 📦 기술 스택

| 영역 | 선택 | 이유 |
|---|---|---|
| 언어 | Node.js 20 + TypeScript (ESM) | Puppeteer/Vercel 생태계 |
| 서버리스 | Vercel Hobby | 무료, 서울 리전(icn1) |
| DB/CMS | Notion API | 무료 + UI 제공 |
| 이미지 | Cloudinary | 무료 25GB + 자동 변환 |
| AI | Gemini 1.5 Flash | 무료 1500 req/day |
| 배치 | GitHub Actions | 무료 2000분/월 |
| PDF | Puppeteer + Handlebars (로컬) | 서버 부하 0 |

## 🚀 빠른 시작

### 1. 의존성 설치

```bash
cd parenting-album
npm install
```

### 2. 환경변수 설정

```bash
cp .env.example .env.local
# .env.local 파일을 열어 실제 값으로 채워넣기
```

필요한 외부 계정:
- [Notion Integration](https://www.notion.so/my-integrations) (무료)
- [Cloudinary](https://cloudinary.com/users/register/free) (무료)
- [Google AI Studio](https://aistudio.google.com/app/apikey) (무료, Gemini API 키)
- [Vercel](https://vercel.com/signup) (무료, Hobby 플랜)
- [카카오톡 채널 + OpenBuilder](https://i.kakao.com/) (무료, Step 1 완성 후 별도 가이드 제공)

### 3. Notion DB 준비

`docs/NOTION_SETUP.md` 참조 (Step 4에서 작성 예정).

### 4. 로컬 개발

```bash
npm run typecheck   # 타입 체크
npm run dev         # Vercel Dev 서버 (Webhook 로컬 테스트)
```

### 5. 배포

```bash
vercel --prod
```

## 📖 명령어 레퍼런스

| 명령어 | 설명 |
|---|---|
| `npm run typecheck` | TypeScript 타입 체크 |
| `npm run dev` | Vercel 로컬 개발 서버 |
| `npm run summarize` | 주간 Gemini 요약 실행 (수동 트리거) |
| `npm run summarize:dry` | 실제 업데이트 없이 드라이런 |
| `npm run build:pdf` | 월간 PDF 생성 (RGB) |
| `npm run build:pdf:cmyk` | 월간 PDF 생성 + CMYK 변환 (Ghostscript 필요) |
| `npm run archive` | 완료된 월의 Cloudinary 원본을 로컬로 이관 |

## 🗂️ 디렉토리 구조

```
parenting-album/
├── api/
│   ├── kakao/webhook.ts        # Phase 1: Kakao 수집 엔드포인트
│   ├── album/[month].ts        # Phase 3-B: 디지털 앨범 SSR
│   └── comment/create.ts       # Phase 3-B: 댓글 작성 API
├── lib/
│   ├── notion.ts               # Notion 클라이언트 + 4개 DB 래퍼
│   ├── cloudinary.ts           # 사진·영상 업로드 + eager 변환
│   ├── gemini.ts               # 주간 에세이 생성 프롬프트
│   ├── kakao.ts                # Kakao 스키마 + 응답 헬퍼
│   ├── gallery.ts              # 디지털 앨범 HTML 빌더 (CSS + JS 인라인)
│   └── idempotency.ts          # 중복 방지 SHA-256 키
├── scripts/
│   ├── weekly-summarize.ts     # Phase 2: 주간 Gemini 배치 (수동/cron)
│   ├── build-pdf.ts            # Phase 3-A: 인쇄용 PDF 빌드 (로컬)
│   ├── convert-cmyk.ts         # Phase 3-A 선택: Ghostscript CMYK 변환
│   └── archive-originals.ts    # 월간 Cloudinary 원본 아카이빙
├── templates/
│   └── album.hbs               # 인쇄 PDF용 Handlebars 템플릿 (A5, 300DPI)
├── docs/
│   ├── DESIGN.md               # 전체 설계서
│   ├── NOTION_SETUP.md         # Notion DB 4개 생성 가이드
│   ├── KAKAO_SETUP.md          # Kakao OpenBuilder 가이드
│   └── VERCEL_SETUP.md         # Vercel 배포 가이드
├── .github/workflows/
│   └── parenting-album-weekly.yml  # 주간 Gemini cron (레포 루트)
├── package.json
├── tsconfig.json
├── vercel.json
├── .env.example
└── README.md
```

## 🔄 운영 루틴

### 매일 (자동)
- 가족이 카톡 "원우 앨범봇"에 사진·영상·메모 전송
- Vercel Webhook이 1초 내 응답 + 백그라운드에서 Cloudinary + Notion 저장

### 매주 일요일 22:00 KST (자동)
- GitHub Actions가 Gemini 1.5 Flash에 지난 주 데이터 전송
- 가족 시점 혼합 에세이 생성 → Weekly_Summary DB에 저장
- 엔트리 Status: `Draft` → `Summarized`

### 매월 (수동, 5~10분)
1. 로컬에서 `npm run build:pdf -- --month=2026-04`
2. `dist/wonwoo-album-2026-04.pdf` 확인 → 스냅스에 업로드 → 인쇄 주문
3. (선택) `npm run build:pdf:cmyk -- --month=2026-04` 로 CMYK 변환
4. `npm run archive -- --month=2026-04 --confirm` 로 Cloudinary 원본 아카이빙

### 상시 (디지털 앨범)
- `https://<vercel-url>/album/2026-04` 로 가족이 웹 감상
- 사진·영상 + 가족별 시점 에세이 + 실시간 댓글

## 📖 설정 가이드 (처음 세팅)

이 순서대로 따라하면 전체 시스템이 동작합니다:

1. **[`docs/NOTION_SETUP.md`](./docs/NOTION_SETUP.md)** — Notion Integration + 4개 DB 생성 (15~20분)
2. **[`docs/VERCEL_SETUP.md`](./docs/VERCEL_SETUP.md)** — Vercel 프로젝트 임포트 + 환경변수 (10~15분)
3. **[`docs/KAKAO_SETUP.md`](./docs/KAKAO_SETUP.md)** — 카카오 채널 + OpenBuilder 봇 생성 (30~45분)
4. GitHub Actions Secrets 등록 (`VERCEL_SETUP.md §7` 참고)
5. 가족에게 카카오 채널 초대 링크 공유 → 끝 🎉

## 📝 개발 진행 상황

- [x] **Step 0**: 프로젝트 스캐폴딩
- [x] **Step 1**: Phase 1 — Kakao Webhook (사진·영상 수집 + 대화형 자동 등록)
- [x] **Step 2**: Phase 2 — 주간 Gemini 요약 (GitHub Actions)
- [x] **Step 3-A**: Phase 3-A — 인쇄용 PDF 빌더 (로컬, A5, 300DPI)
- [x] **Step 3-B**: Phase 3-B — 디지털 앨범 웹 갤러리 (Vercel SSR + 댓글)
- [x] **Step 4**: 운영 문서 (Notion / Kakao / Vercel 가이드)

## 📜 라이선스

Private project — 원우 가족용.
