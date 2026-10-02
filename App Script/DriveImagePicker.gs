/**
 * Chọn ảnh ngẫu nhiên từ 1 thư mục Google Drive (dùng cho nội dung Facebook kèm ảnh).
 */

function extractDriveFolderId_(url) {
  if (!url) return null;
  var trimmed = String(url).trim();
  var match = trimmed.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  if (/^[a-zA-Z0-9_-]{10,}$/.test(trimmed)) return trimmed; // fallback: dán thẳng ID
  return null;
}

/**
 * Chọn ngẫu nhiên từ minCount đến maxCount ảnh trong thư mục.
 * Nếu thư mục có ít hơn minCount ảnh thì lấy hết số ảnh hiện có (không bắt buộc đủ minCount).
 * Trả về mảng Blob, rỗng nếu thư mục không có ảnh nào.
 */
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

  if (images.length === 0) {
    return [];
  }

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
