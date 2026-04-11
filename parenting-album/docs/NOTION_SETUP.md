# Notion 설정 가이드

원우 앨범봇은 **Notion**을 데이터베이스 겸 관리자 UI로 사용합니다.
이 가이드를 따라 **Notion Integration 1개** + **Database 4개**를 만들면 Step 1~3의 모든 코드가 동작할 준비를 갖추게 됩니다.

> 예상 소요 시간: **15~20분**
> 준비물: Notion 무료 계정 (없으시면 https://notion.so 에서 가입)

---

## 0. Notion Integration 생성 (API 키 발급)

1. https://www.notion.so/my-integrations 접속
2. **[+ New integration]** 클릭
3. 폼 작성:
   - **Name**: `wonwoo-album-bot` (아무거나 OK)
   - **Associated workspace**: 본인 워크스페이스 선택
   - **Type**: Internal
4. **[Submit]** 클릭
5. 다음 페이지에서 **Internal Integration Secret** 복사 (`secret_xxxxxxxxxx...`)
   → 이 값이 `.env.local`의 `NOTION_TOKEN` 에 들어갑니다.

**주의**: Secret은 **한 번만** 보여지는 경우가 있으니 안전한 곳(1Password 등)에 바로 저장.

---

## 1. Raw_Entry DB 생성

### 1-1. 페이지 만들기

1. Notion에서 새 페이지 생성 → 이름: `원우 앨범봇`
2. 본문에 `/database` → **Database - Full page** 선택
3. DB 이름: `Raw_Entry`

### 1-2. 프로퍼티 정의

기본 생성된 `Name` 프로퍼티는 **삭제하지 말고** 이름을 `ID`로 변경, 타입 `Title`은 유지.

그 다음 아래 프로퍼티를 하나씩 추가:

| 프로퍼티 이름 | 타입 | 옵션/기본값 |
|---|---|---|
| `ID` | Title | (이름만 변경) |
| `Date` | Date | (Include time 켜기) |
| `Type` | Select | 옵션: `Text`, `Image`, `Video`, `Mixed` |
| `Raw_Content` | Text (rich text) | — |
| `Author` | Text (rich text) | — |
| `Author_ID` | Text (rich text) | — |
| `Media_URL` | URL | — |
| `Media_Print_URL` | URL | — |
| `Media_Thumb_URL` | URL | — |
| `Web_Video_URL` | URL | — |
| `Video_Duration` | Number | Format: Number |
| `Status` | **Status** ⚠️ | 옵션: `Draft`(To-do), `Summarized`(In progress), `Printed`(Complete) |
| `Week_Ref` | Relation | → `Weekly_Summary` (이 DB는 다음 단계에서 만듦. 지금은 일단 비워두고 나중에 추가) |

**⚠️ Status 프로퍼티 주의**: `Select`가 아니라 **`Status`** 타입이어야 합니다. Notion에서 `Status` 타입은 `To-do / In progress / Complete` 3개 그룹으로 나뉘며, 각 그룹 안에 커스텀 옵션을 추가할 수 있습니다.
- `Draft` → To-do 그룹
- `Summarized` → In progress 그룹
- `Printed` → Complete 그룹

### 1-3. Integration 권한 부여

1. DB 오른쪽 위 `···` → **[Connections]** → Integration 이름(`wonwoo-album-bot`) 선택
2. 이렇게 해야 API에서 이 DB에 읽기/쓰기 가능

### 1-4. DB ID 복사

1. 브라우저 주소창의 URL을 봅니다:
   ```
   https://www.notion.so/<workspace>/a1b2c3d4e5f6...?v=...
                                     └─────32자 hex─────┘
   ```
2. `?` 앞의 32자 hex가 **DB ID**입니다.
3. 이 값이 `.env.local`의 `NOTION_DB_RAW_ID` 에 들어갑니다.

---

## 2. Users DB 생성

### 2-1. DB 만들기

위와 같은 방식으로 `원우 앨범봇` 페이지 아래에 새 DB 생성: `Users`

### 2-2. 프로퍼티 정의

| 프로퍼티 | 타입 | 옵션 |
|---|---|---|
| `kakao_user_id` | Title | — |
| `display_name` | Text | — |
| `state` | **Select** | 옵션: `awaiting_name`, `active`, `disabled` |
| `first_seen` | Date | Include time |
| `last_seen` | Date | Include time |

### 2-3. Integration 연결 + DB ID 복사

- `···` → Connections → `wonwoo-album-bot`
- DB ID를 URL에서 복사 → `.env.local`의 `NOTION_DB_USERS_ID`

**주의**: `state`는 `Select` 타입입니다 (Status 아님). 카톡 Webhook이 동작 중에 자동으로 row를 생성·업데이트합니다.

---

## 3. Weekly_Summary DB 생성

### 3-1. DB 만들기: `Weekly_Summary`

### 3-2. 프로퍼티

| 프로퍼티 | 타입 | 옵션 |
|---|---|---|
| `Week_ID` | Title | 예: `2026-W15` |
| `Start_Date` | Date | — |
| `End_Date` | Date | — |
| `Week_Title` | Text | Gemini가 생성 |
| `Essay` | Text | Gemini가 생성 |
| `Entry_Count` | Number | — |
| `Status` | **Status** | 옵션: `Pending`(To-do), `Summarized`(In progress), `Printed`(Complete) |

### 3-3. Raw_Entry의 Week_Ref Relation 연결

이제 `Raw_Entry` DB로 돌아가서:

1. `Week_Ref` 프로퍼티 수정
2. 타입: **Relation**
3. Related to: `Weekly_Summary`
4. (선택) Two-way 관계로 설정하면 Weekly_Summary에서도 속한 엔트리 목록 보임

### 3-4. Integration 연결 + DB ID 복사

- Connections → `wonwoo-album-bot`
- DB ID → `.env.local`의 `NOTION_DB_WEEKLY_ID`

---

## 4. Comments DB 생성

### 4-1. DB 만들기: `Comments`

### 4-2. 프로퍼티

| 프로퍼티 | 타입 | 옵션 |
|---|---|---|
| `comment_id` | Title | — |
| `moment_ref` | Relation | → `Raw_Entry` |
| `author_name` | Text | — |
| `author_kakao_id` | Text | — |
| `text` | Text | — |
| `created_at` | Date | Include time |
| `ip_hash` | Text | — |

### 4-3. Integration 연결 + DB ID 복사

- Connections → `wonwoo-album-bot`
- DB ID → `.env.local`의 `NOTION_DB_COMMENTS_ID`

---

## 5. `.env.local` 최종 확인

`parenting-album/.env.local` 파일이 아래 값들로 채워져 있어야 합니다:

```env
# Kakao
KAKAO_WEBHOOK_SECRET=random-long-string-here

# Notion
NOTION_TOKEN=secret_xxxxxxxxxxxxxxxxx
NOTION_DB_RAW_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
NOTION_DB_USERS_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
NOTION_DB_WEEKLY_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
NOTION_DB_COMMENTS_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Cloudinary
CLOUDINARY_CLOUD_NAME=your-cloud-name
CLOUDINARY_API_KEY=xxxxxxxxxxxxxxx
CLOUDINARY_API_SECRET=xxxxxxxxxxxxxxx
CLOUDINARY_FOLDER=wonwoo-album

# Gemini
GEMINI_API_KEY=AIzaxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

---

## 6. 동작 확인 (스모크 체크)

터미널에서:

```bash
cd parenting-album
npm run typecheck   # 타입 에러 0건이어야 함
```

실제 Notion과 통신 테스트:
```bash
# 아래는 실제 Notion 읽기가 발생하므로 환경변수 필수
npx tsx -e "
import { listActiveUsers } from './lib/notion.js';
const users = await listActiveUsers();
console.log('Active users:', users);
"
```
(처음엔 비어있는 게 정상. 카톡으로 사용자가 등록되면 채워집니다.)

---

## 7. 관리자 운영 팁

### 가족 강제 추가/수정
- `Users` DB에서 직접 row 추가 가능 (kakao_user_id 알고 있을 때)
- `state`를 `disabled`로 바꾸면 해당 사용자는 봇에서 차단
- `display_name` 수정 가능 (이미 쌓인 Raw_Entry의 Author는 소급 변경 안 됨)

### 앨범 복원
- 에세이가 마음에 안 들면: Weekly_Summary row 삭제 → 다음 배치가 재생성
- 엔트리 Status를 `Draft`로 되돌리면 다음 배치에 다시 포함됨

### 용량 관리
- 매월 PDF 출력 후 `npm run archive -- --month=YYYY-MM` 실행해 Cloudinary 원본을 로컬로 이동
- 1년 이상 운영 시 필수 (무료 티어 25GB 초과 방지)

---

## 8. 트러블슈팅

### "object_not_found" 에러
→ Integration이 해당 DB에 연결되지 않았음. 각 DB 페이지의 `···` → Connections에서 `wonwoo-album-bot` 추가.

### "validation_error" 에러
→ 프로퍼티 이름이 정확히 일치하지 않음. 대소문자, 밑줄(`_`) 주의.

### "Status" 프로퍼티가 Select로 만들어진 경우
→ 반드시 **Status** 타입으로 재생성. Select로는 `Raw_Entry`/`Weekly_Summary`의 Status 필드를 읽지 못함.
