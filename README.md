Cách build file .exe 
B1: thêm vào packgage.json :
"scripts": {
  "package:portable": "ts-node ./.erb/scripts/clean.js dist && npm run build && electron-builder build --win portable --publish never"
}
B2: chạy yarn package:portable
B3: file exe đc lưu ở /release/build
B4: chạy file .exe là có thể sử dụng ứng dụng
*Những vấn đề đã gặp phải:
- Bị dính Chính sách CORS do gọi API HTTP trực tiếp trong Renderer do vì Chromium chặn do CORS, nên gọi qua Main process (node.js k bị chặn)
- Lúc build thì bật chế độ Developer Mode
- Lỗi notarize trên Windows (hook macOS của ERB) với log “Unable to require .erb/scripts/notarize.js (ESM)”: mở package.json tìm đến build xoá dòng “afterSign”: “.erb/scripts/notarize.js”
