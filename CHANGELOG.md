## 2021-11-03

Features:
- SDK version to 2.1.0
- Support comparing 2+ items

Fix:
- Comparision terms
- Don't output average value
- Session and concurrency for a lot of URLs (thousands)

## 2021-09-20

Features:
- More crawler options on input

Bug fixes:
- Re-patch SDK for 429 error
- Don't use Chrome by default unless it's blocked
- Don't close the browser midway the navigation

## 2021-09-10

Features:
- Update SDK to 2.0.7

Changes:
- Lint

Bug fixes:
- Catch 429 code and keep the cookies
