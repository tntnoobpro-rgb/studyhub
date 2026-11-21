# StudyHub – Học thông minh

Dự án website ôn tập tiếng Việt: trắc nghiệm, thi thử, Flashcard, Match và ôn câu sai. Giao diện thích ứng điện thoại.

## Chạy trực tiếp, không cài đặt

Mở file **`StudyHub_Offline.html`** nằm cùng cấp với README bằng Chrome, Edge hoặc Safari. Bản này lưu câu hỏi và kết quả bằng `localStorage` **chỉ trên thiết bị đang mở**. Không có máy chủ, không hỗ trợ chia sẻ bộ học giữa người khác hoặc nhận PDF/DOCX trực tiếp. Hỗ trợ dán văn bản, TXT, JSON, CSV và nhập thủ công. Đăng ký/đăng nhập không thực hiện trong bản offline.

## Chạy bản có máy chủ (dành cho chia sẻ link thật)

Yêu cầu: **Node.js 22.13+** và npm. Trong thư mục `studyhub`:

```bash
npm install
npm start
```

Truy cập `http://localhost:3000`.

- Đăng ký tài khoản, tạo bộ học mới, thêm bộ câu hỏi, duyệt đáp án.
- Đổi quyền của bộ học từ **Riêng tư** sang **Ai có link** hoặc **Công khai**, sau đó sao chép đường link `/study/ID`.
- Nhiều người truy cập cùng địa chỉ server có thể học chung bộ câu hỏi, không cần đăng nhập nếu được chia sẻ. Người đăng nhập lưu tiến độ vào SQLite riêng; khách lưu vào bộ nhớ trình duyệt của mình.
- File hỗ trợ: PDF chứa văn bản, DOCX, PPTX, XLSX, TXT, CSV, JSON. PDF scan hoặc hình ảnh chữ **chưa có OCR**. Bố cục phức tạp có thể cần sửa thủ công.

## Đưa lên Internet

Cần máy chủ Node có **ổ đĩa ghi được và lưu bền vững**, ví dụ VPS hoặc hosting Node hỗ trợ persistent disk. Không nên triển khai nguyên trạng với SQLite lên Vercel serverless: hệ thống file tạm sẽ làm mất dữ liệu. Cấp domain HTTPS (được cấu hình bởi nhà cung cấp hosting), dùng biến môi trường:

```env
NODE_ENV=production
PORT=3000
DATA_DIR=/duong-dan-o-dia-ben-vung
SESSION_SECRET=chuoi-bi-mat-dai-ngau-nhien
```

Khi deploy server, cài dependencies bằng `npm install`, chạy `npm start`, gắn ổ đĩa bền vững vào `DATA_DIR`, thiết lập HTTPS và sao lưu SQLite định kỳ. Tham khảo `.env.example`.

## Cấu trúc

- `server.js` – API đăng ký/đăng nhập, bộ học, câu hỏi, tiến độ, trích xuất tài liệu, SQLite.
- `public/app.js` – giao diện và logic ôn tập.
- `public/style.css` – giao diện responsive/dark mode.
- `public/index.html` – trang chủ.
- `StudyHub_Offline.html` – phiên bản dùng thử trên một thiết bị, không cần cài thư viện.

## Định dạng nhập văn bản

```text
Câu 1. Thủ đô Việt Nam là?
A. Huế
B. Hà Nội
C. Đà Nẵng
D. Cần Thơ
Đáp án: B
Giải thích: Hà Nội là thủ đô.

Câu 2. Chọn các số nguyên tố.
A. 2
B. 4
C. 3
D. 9
Đáp án: A, C
```

Duy trì thứ tự câu hỏi, có thể đảo vị trí phương án mà không làm thay đổi đáp án đúng (dùng ID thay vì chữ A/B/C/D để chấm). Không tự suy đoán đáp án khi không được cung cấp. Trong trình quản lý, chọn các đáp án đúng rồi đánh dấu **Đã xác minh**.

## Giới hạn hiện tại

- Không có AI tạo câu mới từ bài lý thuyết, OCR PDF scan, Google OAuth, cộng tác chỉnh sửa theo lời mời, realtime đồng bộ phiên và hệ thống gửi email.
- Lưu tiến độ mức bộ học cho mỗi tài khoản; việc sửa/xóa câu hỏi có thể khiến thống kê cũ không còn khớp. Chưa có lưu phiên bản lịch sử câu hỏi.
- Một số định dạng phức tạp (bảng trong DOCX/PDF, biểu thức hoặc ảnh) chỉ trích xuất văn bản và cần kiểm tra bản nhập.
- Việc bảo mật/rate-limiting, backup, chống lạm dụng, giám sát và kiểm thử tải cần được tăng cường trước khi phát hành quy mô lớn.
- Hệ thống dùng SQLite và Node server lâu dài. Nếu cần triển khai serverless/scale nhiều máy, cần chuyển dữ liệu sang PostgreSQL/Supabase và bổ sung RLS.
