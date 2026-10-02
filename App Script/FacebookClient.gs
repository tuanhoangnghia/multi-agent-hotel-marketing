/**
 * Lớp gọi Facebook Graph API để tạo bài đăng ở chế độ chưa đăng (draft) kèm ảnh.
 */

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

    if (code === 200) {
      return JSON.parse(body);
    }

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
  if (response.getResponseCode() === 200) {
    return JSON.parse(response.getContentText());
  }
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
