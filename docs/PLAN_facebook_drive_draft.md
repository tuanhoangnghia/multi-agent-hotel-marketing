# Facebook: tự động tạo bài đăng (draft) kèm ảnh từ Google Drive

## Context

Hiện tại nhánh Facebook trong `Agent4_PlatformContent.gs` chỉ sinh **text** (`facebook_copy`) bằng Claude, không có ảnh, không đăng lên đâu cả — người dùng phải tự copy nội dung ra và tự đăng. Mục tiêu của thay đổi này: khi có nội dung Facebook được sinh ra, tự động chọn **5-10 ảnh ngẫu nhiên** (album) từ thư mục Google Drive của khách sạn đó (nếu có), rồi tạo sẵn 1 bài đăng **chưa publish** (draft) kèm toàn bộ ảnh đó trên fanpage — để người quản lý chỉ cần vào Meta Business Suite duyệt & bấm đăng, không phải soạn lại từ đầu.

Các quyết định đã chốt với người dùng (không cần hỏi lại):
- Chưa có Facebook App/Page Access Token nào — cần hướng dẫn từ đầu (có ở cuối plan).
- Tất cả khách sạn đăng chung **1 fanpage** — Page ID + Page Access Token cấu hình 1 lần, không phải theo từng dòng.
- "Chế độ chờ" = **unpublished draft** (`published=false`, không hẹn giờ) — bài nằm trong Meta Business Suite / Publishing Tools để người quản lý tự duyệt & đăng tay, không tự động public.
- Cột ảnh trong sheet chứa **link đầy đủ** của thư mục Drive (`https://drive.google.com/drive/folders/...`), không phải chỉ ID.
- Mỗi lần chạy chọn ngẫu nhiên **5-10 ảnh gắn chung vào 1 bài đăng dạng album** (không phải nhiều bài riêng). Nếu folder có ít hơn 5 ảnh, vẫn tạo draft với toàn bộ số ảnh hiện có (không bắt buộc đủ 5).

Nguyên tắc thiết kế: lỗi ở bước Facebook/Drive (thư mục sai, hết ảnh, token hỏng, Facebook rate-limit...) **không được** làm hỏng việc tạo persona/brief/nội dung các platform khác của dòng đó — dòng vẫn phải chạy xong và được đánh `status = done` như bình thường, chỉ riêng cột trạng thái Facebook báo lỗi.

## Các file thay đổi / thêm mới

**File mới:**
- `DriveImagePicker.gs` — đọc thư mục Drive, chọn ảnh ngẫu nhiên.
- `FacebookClient.gs` — gọi Facebook Graph API (upload ảnh chưa publish → tạo draft post kèm ảnh), có retry giống `ClaudeClient.gs`, và hàm điều phối "never-throw" nối Drive + Facebook lại với nhau.

**File sửa (thêm nhỏ, không đổi hành vi cũ):**
- `Config.gs` — thêm getter cho Page ID / Page Access Token (giống `getClaudeApiKey_()`).
- `Setup.gs` — thêm 1 hàm thiết lập Facebook Page (2 `ui.prompt` liên tiếp, giống `promptForApiKey`) + 1 hàm test kết nối.
- `Orchestrator.gs` — thêm 2 mục menu; `processHotelRow_` gọi bước Facebook **sau khi** `runPlatformSubAgents_` đã chạy xong toàn bộ (không sửa `Agent4_PlatformContent.gs`); 2 nơi build `requiredColumns` thêm cột mới.
- `Agent5_SaveResults.gs` — thêm 3 cột output Facebook, ghi vào `saveHotelResult_`.

`Agent4_PlatformContent.gs`, `Agent1_ReadHotels.gs`, `ClaudeClient.gs`, `appsscript.json` **không đổi**. Việc gọi bước Facebook chỉ sau khi toàn bộ vòng lặp platform (`runPlatformSubAgents_`) trả về thành công tự nhiên đảm bảo: nếu một platform bất kỳ lỗi (kể cả platform chạy sau facebook trong danh sách), exception ném lên trước, bước Facebook không bao giờ chạy, không có draft "mồ côi" bị tạo ra mà không lưu được kết quả.

## Cột trong sheet

- **Input mới**: `drive_folder_url` — link đầy đủ thư mục Drive ảnh của khách sạn. Được tự tạo (header trống) qua `ensureColumns_` như các cột khác, người dùng tự điền.
- **Output mới**: `fb_post_status`, `fb_post_id`, `fb_post_at` — độc lập hoàn toàn với cột `status`/`last_run_at` hiện có.

Lý do bắt buộc phải tách riêng: `readHotelRows_` chỉ bỏ qua dòng khi `status === 'done'`. Nếu gộp lỗi Facebook vào `status`, mỗi lần chạy lại cả batch sẽ tưởng dòng "chưa xong" và **sinh lại toàn bộ persona/brief/text từ Claude** — tốn tiền/API call — chỉ vì một lỗi Facebook không liên quan (token hỏng, thư mục Drive sai...). Giữ riêng cột giúp dòng vẫn `done` đúng nghĩa, còn tình trạng Facebook hiển thị riêng để người dùng biết cần sửa gì.

Giá trị `fb_post_status`: `skipped: no_drive_folder`, `skipped: no_facebook_config`, `skipped: no_images_found`, `draft_created (N ảnh)`, hoặc `error: <thông báo>` — phân biệt rõ nguyên nhân để người dùng không rành kỹ thuật cũng biết cần làm gì tiếp (điền cột Drive, thêm ảnh vào folder, hay chạy lại thiết lập Facebook).

## Chi tiết implementation

### `DriveImagePicker.gs` (mới)

```js
function extractDriveFolderId_(url) {
  if (!url) return null;
  var trimmed = String(url).trim();
  var match = trimmed.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  if (/^[a-zA-Z0-9_-]{10,}$/.test(trimmed)) return trimmed; // fallback: dán thẳng ID
  return null;
}

// Chọn ngẫu nhiên từ minCount đến maxCount ảnh; nếu folder có ít hơn minCount thì lấy hết số ảnh hiện có.
function pickRandomImagesFromFolder_(driveFolderUrl, minCount, maxCount) {
  var folderId = extractDriveFolderId_(driveFolderUrl);
  if (!folderId) {
    throw new Error('URL thư mục Drive không hợp lệ: ' + driveFolderUrl);
  }

  var folder;
  try {
    folder = DriveApp.getFolderById(folderId);
  } catch (error) {
    throw new Error('Không truy cập được thư mục Drive (chưa share hoặc ID sai): ' + folderId);
  }

  var images = [];
  var files = folder.getFiles();
  while (files.hasNext()) {
    var file = files.next();
    if ((file.getMimeType() || '').indexOf('image/') === 0) {
      images.push(file);
    }
  }

  if (images.length === 0) return []; // chưa có ảnh — không phải lỗi

  shuffleArray_(images);
  var count = Math.min(images.length, randomIntBetween_(minCount, maxCount));
  return images.slice(0, count).map(function (file) { return file.getBlob(); });
}

function shuffleArray_(array) {
  for (var i = array.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var tmp = array[i];
    array[i] = array[j];
    array[j] = tmp;
  }
}

function randomIntBetween_(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}
```

Ghi chú: `folder.getFiles()` không đệ quy vào subfolder (đủ dùng cho "1 folder ảnh phẳng mỗi khách sạn"), tự lọc mime `image/*` nên không cần allowlist định dạng riêng. Số lượng ảnh mỗi lần (5-10) được cấu hình ở `FB_MIN_IMAGES_`/`FB_MAX_IMAGES_` trong `FacebookClient.gs`, không hard-code ở đây — giữ file này thuần "đọc Drive", không biết gì về Facebook.

### `FacebookClient.gs` (mới)

```js
var FB_GRAPH_VERSION_ = 'v19.0';
var FB_GRAPH_BASE_ = 'https://graph.facebook.com/' + FB_GRAPH_VERSION_;
var FB_MAX_RETRIES_ = 3;
var FB_MIN_IMAGES_ = 5;
var FB_MAX_IMAGES_ = 10;

function fbGraphPost_(path, payload) {
  var options = { method: 'post', payload: payload, muteHttpExceptions: true };
  var lastError = null;

  for (var attempt = 0; attempt <= FB_MAX_RETRIES_; attempt++) {
    var response = UrlFetchApp.fetch(FB_GRAPH_BASE_ + path, options);
    var code = response.getResponseCode();
    var body = response.getContentText();

    if (code === 200) return JSON.parse(body);

    if (code === 429 || code >= 500) {
      lastError = new Error('Facebook API lỗi tạm thời (HTTP ' + code + '): ' + body);
      Utilities.sleep(1000 * Math.pow(2, attempt));
      continue;
    }

    throw new Error('Facebook API lỗi (HTTP ' + code + '): ' + fbErrorMessage_(body));
  }

  throw lastError || new Error('Facebook API thất bại sau nhiều lần thử lại');
}

function fbErrorMessage_(body) {
  try {
    var json = JSON.parse(body);
    return (json.error && json.error.message) ? json.error.message : body;
  } catch (e) {
    return body;
  }
}

function fbUploadUnpublishedPhoto_(pageId, pageToken, imageBlob) {
  var json = fbGraphPost_('/' + pageId + '/photos', {
    access_token: pageToken,
    published: 'false',
    source: imageBlob, // Blob trong payload -> UrlFetchApp tự chuyển multipart/form-data
  });
  return json.id;
}

function fbCreateDraftPost_(pageId, pageToken, message, photoIds) {
  var json = fbGraphPost_('/' + pageId + '/feed', {
    access_token: pageToken,
    published: 'false',
    unpublished_content_type: 'DRAFT', // thiếu tham số này Facebook sẽ coi là "dark post" (chỉ dùng cho ads), không hiện trong Nội dung/Bản nháp
    message: message,
    attached_media: JSON.stringify(photoIds.map(function (id) { return { media_fbid: id }; })), // phải là string JSON
  });
  return json.id;
}

function fbDeletePhoto_(photoId, pageToken) {
  try {
    UrlFetchApp.fetch(FB_GRAPH_BASE_ + '/' + photoId, {
      method: 'delete',
      payload: { access_token: pageToken },
      muteHttpExceptions: true,
    });
  } catch (error) {
    console.error('Không xoá được ảnh Facebook orphan ' + photoId + ': ' + error.message);
  }
}

function fbUploadUnpublishedPhotos_(pageId, pageToken, imageBlobs) {
  var photoIds = [];
  try {
    imageBlobs.forEach(function (blob) {
      photoIds.push(fbUploadUnpublishedPhoto_(pageId, pageToken, blob));
    });
  } catch (error) {
    photoIds.forEach(function (id) { fbDeletePhoto_(id, pageToken); }); // best-effort dọn ảnh đã upload dở
    throw error;
  }
  return photoIds;
}

function fbCreateDraftPostWithPhotos_(pageId, pageToken, message, imageBlobs) {
  var photoIds = fbUploadUnpublishedPhotos_(pageId, pageToken, imageBlobs);
  try {
    return fbCreateDraftPost_(pageId, pageToken, message, photoIds);
  } catch (error) {
    photoIds.forEach(function (id) { fbDeletePhoto_(id, pageToken); }); // best-effort, không che lỗi thật
    throw error;
  }
}

function fbValidatePageToken_(pageId, pageToken) {
  var url = FB_GRAPH_BASE_ + '/' + pageId + '?fields=id,name&access_token=' + encodeURIComponent(pageToken);
  var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (response.getResponseCode() === 200) return JSON.parse(response.getContentText());
  throw new Error(fbErrorMessage_(response.getContentText()));
}

// Hàm điều phối chính — KHÔNG BAO GIỜ throw, luôn trả về {status, postId?}.
function maybePostFacebookDraft_(hotel, facebookCaption) {
  var folderUrl = hotel && hotel['drive_folder_url'];
  if (!folderUrl || String(folderUrl).trim() === '') {
    return { status: 'skipped: no_drive_folder' };
  }
  if (!isFacebookConfigured_()) {
    return { status: 'skipped: no_facebook_config' };
  }

  try {
    var imageBlobs = pickRandomImagesFromFolder_(folderUrl, FB_MIN_IMAGES_, FB_MAX_IMAGES_);
    if (imageBlobs.length === 0) {
      return { status: 'skipped: no_images_found' };
    }
    var postId = fbCreateDraftPostWithPhotos_(
      getFacebookPageId_(), getFacebookPageToken_(), facebookCaption, imageBlobs
    );
    return { status: 'draft_created (' + imageBlobs.length + ' ảnh)', postId: postId };
  } catch (error) {
    console.error('Lỗi tạo draft Facebook: ' + error.message);
    return { status: 'error: ' + error.message };
  }
}
```

### `Config.gs` (thêm)

```js
function getFacebookPageId_() {
  var id = getScriptProp_('FB_PAGE_ID', '');
  if (!id) throw new Error('Chưa thiết lập FB_PAGE_ID. Vào menu "🤖 AI Marketing" > "Thiết lập Facebook Page".');
  return id;
}

function getFacebookPageToken_() {
  var token = getScriptProp_('FB_PAGE_ACCESS_TOKEN', '');
  if (!token) throw new Error('Chưa thiết lập FB_PAGE_ACCESS_TOKEN. Vào menu "🤖 AI Marketing" > "Thiết lập Facebook Page".');
  return token;
}

function isFacebookConfigured_() {
  return !!getScriptProp_('FB_PAGE_ID', '') && !!getScriptProp_('FB_PAGE_ACCESS_TOKEN', '');
}
```

Script Properties mới: `FB_PAGE_ID`, `FB_PAGE_ACCESS_TOKEN`.

### `Setup.gs` (thêm)

```js
function promptForFacebookPage() {
  var ui = SpreadsheetApp.getUi();
  var props = PropertiesService.getScriptProperties();

  var idResult = ui.prompt('Thiết lập Facebook Page (1/2)', 'Dán Facebook Page ID:', ui.ButtonSet.OK_CANCEL);
  if (idResult.getSelectedButton() !== ui.Button.OK) return;
  var pageId = idResult.getResponseText().trim();
  if (!pageId) { ui.alert('Page ID trống, chưa lưu.'); return; }

  var tokenResult = ui.prompt('Thiết lập Facebook Page (2/2)', 'Dán Page Access Token (nên dùng long-lived token):', ui.ButtonSet.OK_CANCEL);
  if (tokenResult.getSelectedButton() !== ui.Button.OK) return;
  var pageToken = tokenResult.getResponseText().trim();
  if (!pageToken) { ui.alert('Access Token trống, chưa lưu.'); return; }

  props.setProperty('FB_PAGE_ID', pageId);
  props.setProperty('FB_PAGE_ACCESS_TOKEN', pageToken);

  try {
    var page = fbValidatePageToken_(pageId, pageToken);
    ui.alert('Đã lưu và xác thực thành công. Trang: ' + page.name);
  } catch (error) {
    ui.alert('Đã lưu nhưng xác thực thất bại: ' + error.message +
      '\n\nKiểm tra lại Page ID / Access Token, hoặc chạy "Kiểm tra kết nối Facebook" sau khi sửa.');
  }
}

function testFacebookConnection() {
  var ui = SpreadsheetApp.getUi();
  try {
    var page = fbValidatePageToken_(getFacebookPageId_(), getFacebookPageToken_());
    ui.alert('Kết nối OK. Trang: ' + page.name + ' (ID: ' + page.id + ')');
  } catch (error) {
    ui.alert('Kết nối lỗi: ' + error.message);
  }
}
```

Lưu trước, validate sau: nếu Facebook API tạm thời không phản hồi lúc lưu, người dùng không phải paste lại token.

### `Orchestrator.gs` (sửa)

`onOpen()` — thêm 2 mục menu (sau "Thiết lập API Key"):
```js
.addItem('Thiết lập Facebook Page', 'promptForFacebookPage')
.addItem('Kiểm tra kết nối Facebook', 'testFacebookConnection')
```

`processHotelRow_` — thêm bước Facebook sau khi có `platformContentMap`:
```js
function processHotelRow_(sheet, row, columnMap, platforms) {
  var hotel = row.hotel;
  console.log('Đang xử lý dòng ' + row.rowNumber + ': ' + getHotelName_(hotel));

  var persona = selectBuyerPersona_(hotel);
  var brief = writeCampaignBrief_(hotel, persona);
  var platformContentMap = runPlatformSubAgents_(hotel, persona, brief, platforms);

  var facebookPostResult = null;
  if (platformContentMap.facebook) {
    facebookPostResult = maybePostFacebookDraft_(hotel, platformContentMap.facebook);
  }

  saveHotelResult_(sheet, row.rowNumber, columnMap, {
    persona: persona,
    brief: brief,
    platformContentMap: platformContentMap,
    facebookPostResult: facebookPostResult,
  });
}
```

`runMarketingAutomation()` và `runForActiveRow()` — dòng build `requiredColumns` ở cả 2 nơi đổi thành:
```js
var requiredColumns = REQUIRED_OUTPUT_COLUMNS_.concat(platformColumns, FB_POST_COLUMNS_, FB_INPUT_COLUMNS_);
```

### `Agent5_SaveResults.gs` (sửa)

```js
var FB_POST_COLUMNS_ = ['fb_post_status', 'fb_post_id', 'fb_post_at'];
var FB_INPUT_COLUMNS_ = ['drive_folder_url'];
```

Trong `saveHotelResult_`, trước khi ghi `status`/`last_run_at`:
```js
if (result.facebookPostResult && columnMap['fb_post_status']) {
  sheet.getRange(rowNumber, columnMap['fb_post_status']).setValue(result.facebookPostResult.status);
  sheet.getRange(rowNumber, columnMap['fb_post_id']).setValue(result.facebookPostResult.postId || '');
  sheet.getRange(rowNumber, columnMap['fb_post_at']).setValue(new Date());
}
```

`saveHotelError_` không đổi — chỉ dùng cho lỗi persona/brief/text-gen thật, không bao giờ do bước Facebook.

## Hướng dẫn thiết lập Facebook App/Page Token (làm 1 lần, thủ công)

Đây là quy trình đã đi qua thực tế, ghi lại đúng tên nút/màn hình đã gặp (giao diện Meta hay đổi UI nên có thể lệch chút, nhưng luồng và tên trường quyền thì không đổi) — kèm các lỗi thường gặp và cách nhận biết để người làm sau không mất công dò lại.

### Bước 1 — Tạo app trên Meta for Developers

1. Vào `developers.facebook.com/apps` bằng đúng tài khoản Facebook **là admin của fanpage** cần đăng bài (rất quan trọng — nếu dùng tài khoản khác, các bước sau sẽ không thấy fanpage đâu).
2. Bấm **"Tạo ứng dụng"** → nhập tên app (ví dụ "Marketting AI") → bấm tiếp để qua bước **"Trường hợp sử dụng"**.

### Bước 2 — Chọn đúng "Trường hợp sử dụng" (use case)

3. Ở màn hình "Thêm trường hợp sử dụng", cột bên trái có filter theo nhóm ("Đáng chú ý", "Tất cả", "Quảng cáo và kiếm tiền", "Quản lý nội dung", "Nhắn tin doanh nghiệp", "Khác"). **Danh sách mặc định hiện ra ("Đáng chú ý") không có mục đúng** — đừng chọn Marketing API, App Ads, Threads, Instant Games, Facebook Login, hay WhatsApp.
4. Bấm filter **"Quản lý nội dung"** ở bên trái → chọn use case **"Quản lý mọi thứ trên Trang"** (Manage everything on your Page). Đây là use case cấp các quyền `pages_show_list`, `pages_manage_posts`, `pages_read_engagement` cần dùng.
5. Hoàn tất wizard tạo app (các bước "Doanh nghiệp", "Yêu cầu", "Tổng quan" — điền cơ bản, không cần đăng ký gì đặc biệt).

### Bước 3 — Thêm quyền cho use case

6. Ở Bảng điều khiển app, mục "Tùy chỉnh ứng dụng và các yêu cầu" sẽ có 3 dòng: "Tùy chỉnh trường hợp sử dụng Quản lý mọi thứ trên Trang", "Thử nghiệm trường hợp sử dụng", "Kiểm tra để đảm bảo rằng bạn đã hoàn tất mọi yêu cầu". Bấm vào dòng **đầu tiên**.
7. Ở tab **"Quyền và tính năng"**, danh sách quyền hiển thị sắp xếp theo alphabet (chữ hoa trước, chữ thường sau) nên các quyền cần tìm nằm khá xa phía dưới — cuộn xuống (hoặc Ctrl+F) tìm và bấm **"+ Thêm"** cho đúng 3 quyền:
   - `pages_show_list`
   - `pages_manage_posts`
   - `pages_read_engagement`
8. Bỏ qua mục **"Trở thành Nhà cung cấp công nghệ"** ở Bảng điều khiển — chỉ cần khi app xin quyền dữ liệu từ tài khoản/doanh nghiệp của người khác, không liên quan việc tự đăng lên page của chính mình.
9. Mục **"Kiểm tra để đảm bảo bạn đã hoàn tất mọi yêu cầu"** chỉ cần nếu định nộp App Review để app "go live" công khai — với mục tiêu chỉ đăng lên 1 fanpage do chính bạn quản lý, **không cần** App Review, cứ để app ở **Development Mode**.

### Bước 4 — Lấy Access Token qua Graph API Explorer

10. Vào **"Trường hợp sử dụng" → "Xét duyệt" → "Thử nghiệm"**. Màn hình này có thể hiện dòng "Quản lý mọi thứ trên Trang" với trạng thái "Chưa bắt đầu thử nghiệm được" — **bỏ qua**, không phải bước bắt buộc. Bấm nút **"Mở Trình khám phá API Đồ thị"**.
11. Trong Graph API Explorer:
    a. Dropdown **"Ứng dụng trên Meta"** → chọn đúng app vừa tạo.
    b. Dropdown **"Người dùng hoặc Trang"** (mặc định hiện "Lấy mã") → **bấm và chọn đúng tên fanpage** trong danh sách hiện ra.
       > ⚠️ **Lỗi thường gặp**: nếu bỏ qua bước này (để mặc định), token tạo ra sẽ là **User Access Token** đại diện cho chính tài khoản cá nhân của bạn, không phải Page. Dấu hiệu nhận biết: ở bước validate sau (mục 13), nếu thấy trả về **tên cá nhân của bạn** thay vì tên fanpage — quay lại bước này chọn lại đúng Page.
    c. Mục "Quyền" → bấm dropdown **"Thêm quyền"** → thêm lần lượt `pages_show_list`, `pages_manage_posts`, `pages_read_engagement`.
    d. Bấm nút xanh **"Generate Access Token"** → xác nhận đăng nhập/cấp quyền trên popup hiện ra.
12. Sau khi ô "Mã truy cập" có giá trị, bấm nút **"Gửi"** (cạnh khung URL `graph.facebook.com/v26.0/me?fields=id,name` sẵn có) để xác nhận: kết quả trả về phải là **`id` + `name` của fanpage**, không phải tên cá nhân.
13. Để lấy toàn bộ Page bạn quản lý cùng token riêng từng Page, có thể gọi `GET /me/accounts` — kết quả trả về dạng:
    ```json
    {"data":[{"access_token":"...", "category":"...", "name":"Tên Page", "id":"1234567890", "tasks":[...]}], "paging": {...}}
    ```
    Trong đó `id` = **Page ID**, `access_token` = **Page Access Token** của đúng Page đó (theo `name`).
    > ⚠️ Nếu `name` trả về không đúng fanpage khách sạn (ví dụ ra 1 page hoàn toàn không liên quan) — nghĩa là tài khoản Facebook đang dùng để xác thực **không quản lý** fanpage khách sạn, hoặc ở bước 11.b chưa chọn đúng Page. Cần đăng nhập/chọn lại đúng tài khoản là admin của fanpage khách sạn.

### Bước 5 — Đổi sang long-lived token

14. Token vừa lấy ở Graph API Explorer là **short-lived** (~1-2 giờ). Lấy **App ID** + **App Secret** ở menu bên trái **"Cài đặt ứng dụng" → "Cơ bản"**.
15. Gọi `GET https://graph.facebook.com/v19.0/oauth/access_token?grant_type=fb_exchange_token&client_id=<APP_ID>&client_secret=<APP_SECRET>&fb_exchange_token=<SHORT_LIVED_TOKEN>` → được long-lived **user** token.
16. Gọi lại `GET https://graph.facebook.com/v19.0/me/accounts?access_token=<LONG_LIVED_USER_TOKEN>` → lấy **Page** ID + Page Access Token lần này sống lâu (không có hạn cố định).
17. **Kiểm tra token đã long-lived chưa** trước khi dùng: vào `https://developers.facebook.com/tools/debug/accesstoken`, dán `access_token` vào, bấm **Debug** → xem dòng **"Expires"**:
    - `"Never"` hoặc 1 ngày rất xa → đúng long-lived, dùng được.
    - Khoảng 1-2 giờ → chưa đúng, quay lại bước 15-16 (thường do bỏ sót bước exchange, gọi `/me/accounts` thẳng bằng token short-lived ban đầu).

### Bước 6 — Lưu vào Google Sheet

18. Vào Google Sheet → menu **🤖 AI Marketing → Thiết lập Facebook Page**, dán Page ID rồi Page Access Token (long-lived). Script tự gọi Graph API kiểm tra và báo đúng tên Page nếu thành công.
19. Thêm/điền cột `drive_folder_url` cho từng khách sạn — link đầy đủ thư mục Drive (dạng `https://drive.google.com/drive/folders/<ID>?...`, phần `?...` ở cuối không ảnh hưởng, script tự cắt bỏ), đã share ít nhất "Anyone with the link – Viewer" (hoặc share trực tiếp với tài khoản Google chạy script), nên có ít nhất 5-10 ảnh để mỗi lần chạy có đủ ảnh chọn ngẫu nhiên (ít hơn vẫn chạy được, chỉ dùng hết số ảnh có).

### Sau khi chạy — nơi xem bài draft

20. Bài draft **không** hiện trên timeline fanpage bình thường (đúng vì chưa publish). Vào **Meta Business Suite** (business.facebook.com) → chọn fanpage → mục **"Nội dung"** → tab **"Bản nháp"** — bài mới sẽ hiện ở đây kèm caption + toàn bộ ảnh đã chọn, chờ duyệt/đăng tay.
    > ⚠️ **Lỗi thực tế đã gặp**: nếu gọi `/feed` với `published=false` mà **không** kèm `unpublished_content_type: 'DRAFT'`, Facebook sẽ coi bài là **"dark post"** (chỉ dùng làm creative cho ads, không hiện ở đâu cho admin xem) — dù `fb_post_status` báo `draft_created` thành công vẫn không tìm thấy bài đâu trên fanpage. Code trong `fbCreateDraftPost_` (`FacebookClient.gs`) đã thêm tham số này để tạo đúng "Bản nháp" hiển thị được.

### Bảo trì

21. Token có thể mất hiệu lực sau vài tuần/tháng (đổi mật khẩu, Facebook thu hồi quyền, app secret bị reset...) — khi đó `fb_post_status` sẽ hiện `error: ... Invalid OAuth access token`, chỉ cần lặp lại từ Bước 4.

## Giới hạn được chấp nhận có chủ đích (không phải thiếu sót)

- Không tự refresh token — khi token hỏng, biết qua `fb_post_status = error: ...`, sửa lại bằng tay qua menu.
- Retry Facebook API chỉ theo mã HTTP 429/5xx (giống `callClaude_`) — một số kiểu rate-limit của Facebook trả về 4xx với `error.code` riêng (4/17/32/613) sẽ không được retry, chỉ báo lỗi ngay. Ổn ở quy mô vài chục dòng/lần chạy.
- Không chống trùng lặp: chạy lại 1 dòng đã `done` (qua reset status hoặc "Chạy dòng đang chọn") có thể tạo thêm 1 draft mới trên Facebook — xoá tay draft dư trong Meta Business Suite nếu cần.
- Không kiểm tra quyền share Drive trước — chỉ báo lỗi khi thực sự chạy.
- Xoá ảnh "mồ côi" khi bước tạo post lỗi chỉ là best-effort — nếu xoá cũng lỗi, ảnh thừa vô hại sẽ nằm lại trong thư viện media của Business Suite.
- Lần chạy đầu tiên sau khi thêm code sẽ có 1 lần Google yêu cầu xác thực lại quyền (do phát hiện dùng `DriveApp` mới).

## Kiểm thử sau khi triển khai

1. Dán các file `.gs` mới/sửa vào Apps Script editor gắn với sheet.
2. Chạy **Thiết lập Facebook Page**, nhập Page ID + long-lived Page Access Token → xác nhận alert báo đúng tên trang.
3. Chạy **Kiểm tra kết nối Facebook** → xác nhận vẫn OK.
4. Điền `drive_folder_url` cho 1 dòng test (folder có ≥10 ảnh để thấy rõ việc chọn ngẫu nhiên 5-10 ảnh, đã share đúng), chạy **Chạy dòng đang chọn**.
5. Kiểm tra: `facebook_copy` có nội dung, `fb_post_status` dạng `draft_created (N ảnh)` với N trong khoảng 5-10, `fb_post_id` có giá trị, `status = done`. Vào Meta Business Suite kiểm tra có draft post dạng album N ảnh + đúng caption, chưa publish. Test thêm 1 dòng với folder chỉ có 2-3 ảnh để xác nhận vẫn tạo draft với đúng số ảnh hiện có (không bắt buộc đủ 5).
6. Test các trường hợp lỗi: dòng không có `drive_folder_url` → `skipped: no_drive_folder`; folder rỗng → `skipped: no_images_found`; token sai (tạm sửa qua menu) → `error: ...` — mỗi trường hợp `status` của dòng vẫn phải là `done` và các cột persona/brief/platform khác vẫn được lưu đầy đủ.
7. Chạy lại **Chạy toàn bộ danh sách** trên sheet có nhiều dòng để xác nhận cơ chế chia batch theo `MAX_RUNTIME_MS` + trigger resume không bị ảnh hưởng.

## Trạng thái triển khai

Đã code xong toàn bộ (2 file mới + 4 file sửa như trên). Còn lại 4 việc thủ công phía bạn: tạo Facebook App/Page Token theo hướng dẫn trên, dán code vào Apps Script editor, chạy "Thiết lập Facebook Page" trong menu, điền cột `drive_folder_url` rồi test theo mục "Kiểm thử sau khi triển khai".
