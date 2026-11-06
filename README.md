# 말씀노트

QT · 설교 기록 · 기도노트 · 달력 · 나눔 그룹을 한곳에서 쓰는 웹앱입니다.
GitHub Pages(정적 호스팅) + Supabase(로그인 · 데이터베이스 · 실시간 · 사진 저장)로 동작합니다.

## 파일

| 파일 | 역할 |
| --- | --- |
| `index.html` | 앱 화면 + 로그인 화면 |
| `app.js` | 말씀노트 앱 본체 (Claude 아티팩트 버전에서 옮겨 옴) |
| `mn.js` | Supabase 연결층: 로그인/가입/승인 대기, 데이터 읽기·쓰기·실시간, 사진, 설정(계정·백업 가져오기) |
| `mn.css` | 로그인 화면 · 설정 추가분 스타일 |
| `admin.html` | 관리자 페이지 (가입 승인, 사용자·그룹 관리, 사이트 설정, 통계) |
| `config.js` | Supabase 주소와 공개(publishable) 키 |
| `vendor/supabase.min.js` | supabase-js 2.45.4 |

## 데이터베이스 (Supabase 프로젝트 `malsseum-note`)

- `accounts` — 계정 (이름, 역할 user/admin, 상태 pending/approved/rejected/suspended). 가입하면 트리거가 자동으로 만들고, `gweonyj315@gmail.com`은 처음부터 관리자·승인 상태.
- `entries`(말씀노트) · `prayers`(기도) · `user_meta`(문구·읽음 표시) — 계정별로 독립.
- `groups` · `memberships` · `joinreqs` · `prshares` · `reactions` · `comments` · `profiles` — 나눔.
- `app_settings` — 자동 승인, 가입 받기, 공지.
- Storage 버킷 `photos` — 기도노트 사진.

모든 표에 RLS가 걸려 있습니다. 승인된 계정만 쓸 수 있고, 말씀노트는 본인 것과 **같은 그룹 멤버의 것만** 읽히며, 기도노트는 본인만 봅니다(나눔에 올린 기도만 그룹에 보임). 참여 코드 그룹은 멤버가 아니면 목록에도 보이지 않고, 서버 함수 `join_group_by_code`로만 들어올 수 있습니다.
스키마 변경 기록은 Supabase 대시보드 → Database → Migrations 에 있습니다.

## 배포

저장소 Settings → Pages → Source: `Deploy from a branch`, Branch: `main` / `(root)`.
