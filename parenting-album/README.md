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
├── api/kakao/webhook.ts        # Phase 1: Vercel Serverless 엔드포인트
├── lib/
│   ├── notion.ts               # Notion 클라이언트 래퍼
│   ├── cloudinary.ts           # 이미지 업로드/변환
│   ├── gemini.ts               # 프롬프트 + Gemini 호출
│   └── kakao.ts                # Kakao 응답 포맷 헬퍼
├── scripts/
│   ├── weekly-summarize.ts     # Phase 2: 주간 배치
│   ├── build-pdf.ts            # Phase 3: PDF 빌드
│   ├── convert-cmyk.ts         # Phase 3 선택: Ghostscript 변환
│   └── archive-originals.ts    # 원본 아카이빙
├── templates/
│   ├── album.hbs               # Handlebars 템플릿
│   └── album.css               # 인쇄용 CSS (A5, 300DPI, page-break)
├── docs/
│   └── DESIGN.md               # 설계서
├── package.json
├── tsconfig.json
├── vercel.json
├── .env.example
└── README.md
```

## 🔄 운영 루틴

### 매일 (자동)
- 카톡으로 사진·메모 전송 → Vercel Webhook이 즉시 저장

### 매주 일요일 22:00 KST (자동)
- GitHub Actions가 Gemini로 지난 주 요약 생성 → Notion 업데이트

### 매월 (수동, 5분)
1. 로컬에서 `npm run build:pdf`
2. 생성된 `dist/wonwoo-album-YYYYMM.pdf` 확인
3. 스냅스/퍼블로토에 업로드하여 인쇄 주문
4. `npm run archive` 로 원본 아카이빙

## 📝 개발 순서

- [x] **Step 0**: 프로젝트 스캐폴딩
- [ ] **Step 1**: Phase 1 — Kakao Webhook
- [ ] **Step 2**: Phase 2 — 주간 Gemini 요약 (GitHub Actions)
- [ ] **Step 3**: Phase 3 — 로컬 PDF 빌더
- [ ] **Step 4**: 운영 문서 (Notion / Kakao 가이드)

## 📜 라이선스

Private project — 원우 가족용.
