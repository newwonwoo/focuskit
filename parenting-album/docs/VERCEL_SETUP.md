# Vercel 배포 가이드

이 문서는 `parenting-album/` 프로젝트를 Vercel에 무료로 배포하는 방법을 안내합니다.

> 예상 소요 시간: **10~15분**
> 전제 조건: GitHub 저장소 접근 권한, Notion/Cloudinary/Gemini API 키

---

## 1. Vercel 계정 만들기

1. https://vercel.com/signup 접속
2. **Continue with GitHub** 로 가입 (GitHub 레포지토리 연동이 필수)
3. Hobby 플랜 선택 (무료)

---

## 2. 프로젝트 임포트

1. Vercel 대시보드 → **[Add New] → [Project]**
2. `newwonwoo/focuskit` 레포 선택
3. Import 클릭

### 중요: Root Directory 설정

`focuskit` 레포는 여러 프로젝트가 같이 있으므로 Vercel이 어느 폴더를 빌드할지 알려줘야 합니다.

1. **Root Directory**: `parenting-album` 입력 (Edit 버튼)
2. **Framework Preset**: `Other` 선택
3. **Build Command**: 빈칸 (또는 `npm run typecheck`)
4. **Output Directory**: 빈칸
5. **Install Command**: `npm install` (기본값)

---

## 3. 환경변수 등록

[Deploy] 누르기 전에 **Environment Variables** 섹션을 펼쳐 아래 값들을 전부 추가:

| 변수 이름 | 값 | 설명 |
|---|---|---|
| `KAKAO_WEBHOOK_SECRET` | (랜덤 32자 이상) | Webhook 보안 |
| `NOTION_TOKEN` | `secret_xxx...` | Notion Integration Secret |
| `NOTION_DB_RAW_ID` | `xxx...` | Raw_Entry DB ID |
| `NOTION_DB_USERS_ID` | `xxx...` | Users DB ID |
| `NOTION_DB_WEEKLY_ID` | `xxx...` | Weekly_Summary DB ID |
| `NOTION_DB_COMMENTS_ID` | `xxx...` | Comments DB ID |
| `CLOUDINARY_CLOUD_NAME` | `your-cloud` | Cloudinary 대시보드에서 확인 |
| `CLOUDINARY_API_KEY` | `000000000000000` | 동일 |
| `CLOUDINARY_API_SECRET` | `xxx...` | 동일 |
| `CLOUDINARY_FOLDER` | `wonwoo-album` | (선택) 이미지 저장 경로 prefix |

> **`GEMINI_API_KEY`는 여기에 추가하지 않아도 됩니다.** Gemini는 GitHub Actions에서만 사용하므로 Vercel에는 필요 없어요.

각 변수를 Production / Preview / Development 모두 체크.

---

## 4. 배포

1. [Deploy] 클릭
2. 빌드 약 1~2분
3. 성공하면 `https://<project-name>.vercel.app` URL이 부여됨

---

## 5. 동작 확인

### 5-1. 간단 헬스체크

```bash
curl -X POST "https://<your-project>.vercel.app/api/kakao/webhook?secret=wrong" \
  -H "Content-Type: application/json" \
  -d '{}'
```

기대 응답: `{"error":"unauthorized"}` (401)
→ secret 검증이 작동 중임을 의미

### 5-2. 정상 페이로드 (가짜 Notion으로는 실패하지만 검증 로직은 확인 가능)

```bash
curl -X POST "https://<your-project>.vercel.app/api/kakao/webhook?secret=실제값" \
  -H "Content-Type: application/json" \
  -d '{
    "userRequest": {
      "utterance": "test",
      "user": { "id": "test-user" }
    },
    "action": { "name": "w", "params": {} }
  }'
```

기대 응답: simpleText JSON (첫 만남이면 환영 메시지)

### 5-3. 디지털 앨범

```
https://<your-project>.vercel.app/album/2026-04
```
또는 직접 API 경로:
```
https://<your-project>.vercel.app/api/album/2026-04
```

기대 결과: HTML 페이지 (데이터 없으면 "아직 이 달의 기록이 없어요" 표시)

---

## 6. Kakao Webhook URL 등록

Vercel이 배포되면 Webhook 전체 URL은:

```
https://<your-project>.vercel.app/api/kakao/webhook?secret=<KAKAO_WEBHOOK_SECRET>
```

이 URL을 [KAKAO_SETUP.md](./KAKAO_SETUP.md)의 **4. 스킬 등록** 단계에 입력합니다.

---

## 7. GitHub Actions Secrets 등록 (Step 2 주간 배치용)

`.github/workflows/parenting-album-weekly.yml` 이 동작하려면 GitHub 레포 Secrets에 환경변수가 등록되어 있어야 합니다.

1. GitHub 레포 → Settings → Secrets and variables → Actions → **[New repository secret]**
2. 아래 8개를 모두 추가:
   - `NOTION_TOKEN`
   - `NOTION_DB_RAW_ID`
   - `NOTION_DB_USERS_ID`
   - `NOTION_DB_WEEKLY_ID`
   - `NOTION_DB_COMMENTS_ID`
   - `GEMINI_API_KEY`
3. (KAKAO/CLOUDINARY는 Vercel만 사용하므로 GitHub Secrets에는 불필요)

등록 후 Actions 탭에서 **수동 실행**(`workflow_dispatch`)으로 `dry_run: true` 옵션을 넣고 한 번 테스트:

1. Actions → `parenting-album / weekly Gemini summarize` → Run workflow
2. `dry_run` = `true` 선택 → Run
3. 로그에서 `[summarize] fetched N draft entries` 확인

---

## 8. 재배포 & 롤백

### 자동 재배포
- `main` 또는 `claude/parenting-album-automation-b4j2w` 브랜치에 푸시 시 자동 재배포
- 다른 브랜치에 푸시하면 Preview 배포 생성

### 수동 롤백
- Vercel 대시보드 → Deployments → 이전 성공 배포 → `Promote to Production`

---

## 9. 무료 한도 체크

Vercel Hobby 플랜 제한:
- Serverless Function 실행 시간: 100 GB-Hours/월
- 요청 수: 100,000/월
- 대역폭: 100 GB/월

원우 앨범봇 예상 사용량:
- Webhook: ~300 req/월 (1회 3초) = ~15 GB-Hours
- 디지털 앨범 뷰: ~500 req/월 (1회 1초) = ~0.5 GB-Hours
- 댓글 작성: ~50 req/월 = 미미

→ **1% 미만 사용**. 여유 충분.

---

## 10. 트러블슈팅

### 빌드 실패: `Cannot find module 'parenting-album/...'`
→ Root Directory 설정 재확인 (parenting-album).

### 500 에러: `NOTION_TOKEN is not set`
→ Vercel 환경변수가 Production 환경에 적용되지 않음. 환경변수 추가 시 Production 체크 확인, 추가 후 [Redeploy] 필수.

### Webhook이 시간 초과 (504)
→ 이 프로젝트는 즉시 응답 + waitUntil 패턴이라 발생하면 안 됨. 로그 확인 필수.

### 카카오에서 "챗봇 응답 지연"
→ Vercel 서울 리전(`icn1`)으로 배포되었는지 확인. `vercel.json`의 `regions` 참조.
