# Pickle PC 🥒

PC에서 **긴 프롬프트를 편하게 쓰고, 파일을 주고받는** 피클 전용 웹 화면입니다.

- 주소: <https://sogic8-web.github.io/pickle-pc/>
- 데이터 저장소(비공개): <https://github.com/sogic8-web/pickle-workspace>

## 무엇을 하는 화면인가

| 탭 | 하는 일 | 저장 위치 |
| --- | --- | --- |
| **보내기** | 제목·프롬프트 입력 + 파일 첨부(드래그 앤 드롭) → 마크다운 요청서 생성 | `inbox/`, 첨부는 `inbox/files/` |
| **받은 결과물** | 피클이 올려 둔 결과물 목록 · 미리보기 · 다운로드 · 삭제 | `outbox/` |
| **보낸 요청** | 지난 요청 기록 보기 · 삭제, 첨부 파일 관리 | `inbox/`, `inbox/files/` |
| **설정** | GitHub 토큰 연결 · 저장소 지정 | 브라우저 `localStorage` |

## 보안 구조

GitHub Free 계정에서는 Pages가 **공개 저장소에서만** 동작합니다. 그래서 저장소를 둘로 나눴습니다.

```
sogic8-web/pickle-pc        (공개)  ← 이 화면의 코드. 개인정보·프롬프트·파일·토큰 없음
sogic8-web/pickle-workspace (비공개) ← 프롬프트, 첨부파일, 결과물
```

- 이 사이트에는 **서버가 없습니다.** 모든 요청은 브라우저에서 사용자가 넣은 토큰으로 GitHub API에 직접 갑니다.
- 토큰은 그 브라우저의 `localStorage`에만 저장되고, 공개 저장소나 제3자에게 전송되지 않습니다.
- 공용 PC에서는 사용 후 **설정 → 토큰 삭제**를 눌러 주세요.

## 처음 한 번만 하는 준비

1. GitHub에서 토큰 발급
   - **Fine-grained (권장)**: <https://github.com/settings/personal-access-tokens/new>
     - Repository access → *Only select repositories* → `pickle-workspace`
     - Permissions → *Contents: Read and write*
   - **Classic**: <https://github.com/settings/tokens/new?scopes=repo&description=Pickle-PC> (`repo` 스코프)
2. 사이트의 **설정** 탭에서 토큰 붙여넣기 → **저장** → `연결됨 ✅` 확인
3. `보내기` 탭에서 프롬프트 작성 → **보내기** → **한 줄 복사** → 피클 앱에 붙여넣기

## 파일 규칙

- 요청서: `inbox/{YYYYMMDD_HHMMSS}_{제목요약}.md` (본문 + 첨부 링크 목록)
- 첨부: `inbox/files/{YYYYMMDD_HHMMSS}_{원본파일명}`
- 결과물: `outbox/` (피클이 올려 둔 파일을 이 화면에서 바로 내려받기)
- 시각은 모두 **한국시간(KST)** 기준입니다.
- GitHub Contents API 특성상 **개별 파일 20MB 이하**를 권장합니다.

## 개발 메모

- 빌드 과정 없는 정적 파일 3개: `index.html`, `assets/style.css`, `assets/app.js`
- GitHub REST API v3 (`/repos/{owner}/{repo}/contents/...`)만 사용, 외부 라이브러리·CDN 없음
- `Ctrl` + `Enter` 전송, 모바일 반응형 지원
