# Notion 스키마 업그레이드 (v2)

v2 자동편집 기능을 쓰려면 `Raw_Entry` DB에 **7개 컬럼 추가** 필요.

## 추가할 컬럼

Notion → `원우 앨범봇` → `Raw_Entry` → 오른쪽 끝 `+` 로 아래 컬럼들을 추가하세요.

| 이름 | 타입 | 설명 |
|---|---|---|
| `Taken_Date` | **Date** (`시간 포함` ON) | EXIF 촬영 시각 (자동 추출) |
| `Media_Width` | **Number** | 사진 가로 픽셀 |
| `Media_Height` | **Number** | 사진 세로 픽셀 |
| `is_hidden` | **Checkbox** | 앨범/PDF에서 제외하고 싶은 사진 수동 체크 |
| `quality_score` | **Number** | 자동 계산 점수 (0~100) |
| `exclude_code` | **Text** | 제외 사유 코드 (`LOW_RES`, `CLUSTER_DUPLICATE` 등) |
| `cluster_id` | **Text** | 유사사진 군집 ID |

### ⚠️ 컬럼 이름 주의
대소문자 정확히 일치해야 합니다 (Notion 프로퍼티는 대소문자 구분).

## 이름 규칙 의도

- **Pascal_Case** (`Taken_Date`, `Media_Width`, `Media_Height`): 기본 미디어 메타데이터
- **snake_case** (`is_hidden`, `quality_score`, `exclude_code`, `cluster_id`): 자동편집 파생 필드

## 컬럼 없어도 문제없음

위 컬럼이 없으면 v2 기능은 작동하지 않지만 **기존 기능은 그대로 작동**합니다.
일부 컬럼만 만들어도 OK. 기본 동작:

- `Taken_Date` 없음 → `Date` (업로드 시각) 기준 정렬
- `is_hidden` 없음 → 모든 사진 포함
- `quality_score` 없음 → 점수 기반 표지/대표컷 기능 skip
- `exclude_code` 없음 → 자동 제외 없음
- `cluster_id` 없음 → 유사사진 군집화 skip
- `Media_Width/Height` 없음 → 세로/가로 구분 없이 기본 템플릿 사용

## 백필 실행 (기존 사진 EXIF 복구)

컬럼 추가 후, 기존 사진의 Taken_Date/해상도를 채우려면:

```
GitHub Actions → parenting-album / backfill EXIF + dimensions
  → Run workflow
  → month = 2026-04 (또는 "all")
  → Run
```

## 점수 재계산 실행

모든 컬럼 채워진 후:

```
GitHub Actions → parenting-album / rescore photos
  → Run workflow
  → month = 2026-04
  → Run
```

이 스크립트가 모든 사진을:
1. 품질 점수 계산 (0~100)
2. 유사사진 군집화
3. 중복 제거 (군집 3위 이하 `CLUSTER_DUPLICATE`)
4. 저해상도 자동 제외 (`LOW_RES`)

## PDF 빌드 흐름 (v2)

1. 지정 월 Raw_Entry 전부 조회
2. `is_hidden=true` 제외
3. `exclude_code` 있음 제외 (단 `LOW_PRINT_QUALITY`는 허용)
4. `Taken_Date` 순으로 정렬
5. 주차별 그룹
6. 주차마다 대표컷 1장(T1/T2) + 나머지는 2장/3장/4장 묶어서 T3/T4/T5
7. 표지 자동 선정 (최고점 세로 사진)
8. 월 소개 페이지 (통계)
9. 회고 페이지 (2위 점수 사진 + AI 주간 제목)
10. 페이지 수 자동: 1~20장 24p, 21~50장 40p, 51장+ 60p
