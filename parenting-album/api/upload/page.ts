import type { VercelRequest, VercelResponse } from '@vercel/node';

import {
  listActiveUsers,
  findUserByKakaoId,
  createRawEntry,
  type NotionUser,
} from '../../lib/notion.js';
import { uploadFromUrl } from '../../lib/cloudinary.js';

/**
 * GET  /api/upload → 웹 업로드 페이지 (HTML)
 * POST /api/upload → Cloudinary 업로드 + Notion 저장 (JSON API)
 *
 * 카카오톡 챗봇은 묶음 사진을 1장만 전달하는 제한이 있으므로,
 * 여러 장을 한 번에 업로드하고 싶을 때 이 웹 페이지를 사용한다.
 *
 * 보안: 등록된 사용자(Users DB active)만 업로드 가능.
 * 접근: URL 자체가 비공개 (가족에게만 공유).
 */
export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  if (req.method === 'GET') {
    const users = await listActiveUsers();
    const html = renderUploadPage(users);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(html);
    return;
  }

  if (req.method === 'POST') {
    try {
      const { authorKakaoUserId, files } = req.body as {
        authorKakaoUserId: string;
        files: Array<{ url: string; name: string }>;
      };

      if (!authorKakaoUserId || !files || !Array.isArray(files) || files.length === 0) {
        res.status(400).json({ error: 'authorKakaoUserId와 files 배열이 필요합니다.' });
        return;
      }

      const user = await findUserByKakaoId(authorKakaoUserId);
      if (!user || user.state !== 'active') {
        res.status(403).json({ error: '등록되지 않은 사용자입니다.' });
        return;
      }

      const displayName = user.displayName ?? '가족';
      const baseFolder = process.env.CLOUDINARY_FOLDER ?? 'wonwoo-album';
      const now = new Date();
      const y = now.getFullYear();
      const m = String(now.getMonth() + 1).padStart(2, '0');
      const folder = `${baseFolder}/${y}-${m}`;

      const results: Array<{ ok: boolean; error?: string }> = [];

      for (let i = 0; i < files.length; i += 1) {
        const file = files[i]!;
        try {
          const publicId = `web_${Date.now()}_${i}`;
          const upload = await uploadFromUrl({
            sourceUrl: file.url,
            folder,
            publicId,
            maxVideoSeconds: 60,
          });
          await createRawEntry({
            idempotencyKey: publicId,
            timestamp: now,
            mediaKind: upload.kind === 'video' ? 'Video' : 'Image',
            rawContent: '',
            author: displayName,
            authorKakaoUserId: user.kakaoUserId,
            media: upload,
          });
          results.push({ ok: true });
        } catch (err) {
          console.error('[upload] file failed', { url: file.url, error: (err as Error).message });
          results.push({ ok: false, error: (err as Error).message });
        }
      }

      const successCount = results.filter((r) => r.ok).length;
      res.status(200).json({ total: files.length, success: successCount, results });
    } catch (err) {
      console.error('[upload] handler error', err);
      res.status(500).json({ error: '서버 오류' });
    }
    return;
  }

  res.status(405).json({ error: 'method not allowed' });
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderUploadPage(users: NotionUser[]): string {
  const userOptions = users
    .filter((u) => u.displayName)
    .map((u) => `<option value="${esc(u.kakaoUserId)}">${esc(u.displayName!)}</option>`)
    .join('\n');

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=5">
<title>원우 앨범 · 사진 업로드</title>
<style>
:root {
  --bg: #faf8f3; --fg: #2a2720; --muted: #786f60;
  --accent: #c86a3f; --card: #fff; --border: #e5dfd2;
}
* { box-sizing: border-box; }
html, body {
  margin: 0; padding: 0;
  font-family: -apple-system, BlinkMacSystemFont, 'Apple SD Gothic Neo', sans-serif;
  background: var(--bg); color: var(--fg);
}
.container { max-width: 480px; margin: 0 auto; padding: 40px 20px 80px; }
h1 { font-size: 28px; text-align: center; margin: 0 0 8px; }
.subtitle { text-align: center; color: var(--muted); font-size: 14px; margin: 0 0 32px; }

.form-group { margin-bottom: 20px; }
label { display: block; font-size: 14px; font-weight: 600; margin-bottom: 8px; color: var(--muted); }
select, input[type=text] {
  width: 100%; padding: 12px 14px; border: 1px solid var(--border);
  border-radius: 10px; font-size: 16px; font-family: inherit; background: var(--card);
}

.file-drop {
  border: 2px dashed var(--border); border-radius: 14px; padding: 40px 20px;
  text-align: center; cursor: pointer; transition: all 0.2s; background: var(--card);
}
.file-drop:hover, .file-drop.dragover { border-color: var(--accent); background: #fef7f3; }
.file-drop input { display: none; }
.file-drop-text { font-size: 16px; color: var(--muted); }
.file-drop-text strong { color: var(--accent); }

.preview-grid {
  display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 16px;
}
.preview-item {
  position: relative; aspect-ratio: 1; border-radius: 8px; overflow: hidden;
  background: #eee;
}
.preview-item img, .preview-item video {
  width: 100%; height: 100%; object-fit: cover;
}
.preview-item .remove {
  position: absolute; top: 4px; right: 4px; width: 24px; height: 24px;
  background: rgba(0,0,0,.6); color: #fff; border: none; border-radius: 50%;
  font-size: 14px; cursor: pointer; display: flex; align-items: center; justify-content: center;
}

.upload-btn {
  width: 100%; padding: 16px; background: var(--accent); color: #fff;
  border: none; border-radius: 12px; font-size: 18px; font-weight: 700;
  cursor: pointer; margin-top: 24px; transition: opacity 0.2s;
}
.upload-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.upload-btn:hover:not(:disabled) { opacity: 0.9; }

.progress { margin-top: 16px; text-align: center; }
.progress-bar {
  width: 100%; height: 6px; background: var(--border); border-radius: 3px;
  overflow: hidden; margin-bottom: 8px;
}
.progress-fill { height: 100%; background: var(--accent); transition: width 0.3s; width: 0%; }
.progress-text { font-size: 13px; color: var(--muted); }

.result { margin-top: 24px; text-align: center; }
.result-success { color: #2d8a4e; font-size: 18px; font-weight: 600; }
.result-link { display: inline-block; margin-top: 12px; color: var(--accent); font-size: 14px; }

.caption-input {
  width: 100%; padding: 10px 14px; border: 1px solid var(--border);
  border-radius: 10px; font-size: 14px; font-family: inherit; background: var(--card);
  margin-top: 16px; resize: none; min-height: 60px;
}
</style>
</head>
<body>
<div class="container">
  <h1>📸 사진 올리기</h1>
  <p class="subtitle">여러 장 한꺼번에 올릴 수 있어요</p>

  <div class="form-group">
    <label>누가 올리나요?</label>
    <select id="author">
      <option value="" disabled selected>이름 선택</option>
      ${userOptions}
    </select>
  </div>

  <div class="file-drop" id="fileDrop">
    <input type="file" id="fileInput" multiple accept="image/*,video/*">
    <div class="file-drop-text">
      <strong>여기를 탭</strong>해서 사진·영상을 선택하세요<br>
      <span style="font-size:13px; color:var(--muted);">여러 장 선택 가능</span>
    </div>
  </div>

  <div class="preview-grid" id="previewGrid"></div>

  <textarea class="caption-input" id="caption" placeholder="한 줄 메모 (선택)" style="display:none;"></textarea>

  <button class="upload-btn" id="uploadBtn" disabled>
    업로드
  </button>

  <div class="progress" id="progress" style="display:none;">
    <div class="progress-bar"><div class="progress-fill" id="progressFill"></div></div>
    <div class="progress-text" id="progressText">준비 중...</div>
  </div>

  <div class="result" id="result" style="display:none;"></div>
</div>

<script>
(function() {
  const CLOUD_NAME = '${esc(process.env.CLOUDINARY_CLOUD_NAME ?? '')}';
  const UPLOAD_PRESET = '${esc(process.env.CLOUDINARY_UPLOAD_PRESET ?? 'wonwoo-unsigned')}';
  const FOLDER = '${esc(process.env.CLOUDINARY_FOLDER ?? 'wonwoo-album')}';

  const fileDrop = document.getElementById('fileDrop');
  const fileInput = document.getElementById('fileInput');
  const previewGrid = document.getElementById('previewGrid');
  const uploadBtn = document.getElementById('uploadBtn');
  const authorSelect = document.getElementById('author');
  const captionInput = document.getElementById('caption');
  const progressDiv = document.getElementById('progress');
  const progressFill = document.getElementById('progressFill');
  const progressText = document.getElementById('progressText');
  const resultDiv = document.getElementById('result');

  let selectedFiles = [];

  // 저장된 이름 복원
  try {
    const last = localStorage.getItem('wonwoo-album-last-author');
    if (last) {
      for (const opt of authorSelect.options) {
        if (opt.value === last) { authorSelect.value = last; break; }
      }
    }
  } catch(e) {}

  fileDrop.addEventListener('click', function() { fileInput.click(); });
  fileDrop.addEventListener('dragover', function(e) { e.preventDefault(); fileDrop.classList.add('dragover'); });
  fileDrop.addEventListener('dragleave', function() { fileDrop.classList.remove('dragover'); });
  fileDrop.addEventListener('drop', function(e) {
    e.preventDefault();
    fileDrop.classList.remove('dragover');
    addFiles(e.dataTransfer.files);
  });
  fileInput.addEventListener('change', function() { addFiles(fileInput.files); });

  function addFiles(fileList) {
    for (const f of fileList) {
      if (f.type.startsWith('image/') || f.type.startsWith('video/')) {
        selectedFiles.push(f);
      }
    }
    renderPreviews();
    updateBtn();
  }

  function renderPreviews() {
    previewGrid.innerHTML = '';
    captionInput.style.display = selectedFiles.length > 0 ? 'block' : 'none';
    selectedFiles.forEach(function(file, idx) {
      const div = document.createElement('div');
      div.className = 'preview-item';
      const url = URL.createObjectURL(file);
      if (file.type.startsWith('video/')) {
        div.innerHTML = '<video src="' + url + '" muted></video>';
      } else {
        div.innerHTML = '<img src="' + url + '">';
      }
      const removeBtn = document.createElement('button');
      removeBtn.className = 'remove';
      removeBtn.textContent = '×';
      removeBtn.onclick = function(e) {
        e.stopPropagation();
        selectedFiles.splice(idx, 1);
        renderPreviews();
        updateBtn();
      };
      div.appendChild(removeBtn);
      previewGrid.appendChild(div);
    });
  }

  function updateBtn() {
    const hasFiles = selectedFiles.length > 0;
    const hasAuthor = authorSelect.value !== '';
    uploadBtn.disabled = !(hasFiles && hasAuthor);
    uploadBtn.textContent = hasFiles
      ? selectedFiles.length + '개 업로드'
      : '업로드';
  }

  authorSelect.addEventListener('change', function() {
    updateBtn();
    try { localStorage.setItem('wonwoo-album-last-author', authorSelect.value); } catch(e) {}
  });

  uploadBtn.addEventListener('click', async function() {
    if (selectedFiles.length === 0 || !authorSelect.value) return;
    uploadBtn.disabled = true;
    progressDiv.style.display = 'block';
    resultDiv.style.display = 'none';

    const total = selectedFiles.length;
    let done = 0;
    let success = 0;
    const now = new Date();
    const month = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0');
    const folder = FOLDER + '/' + month;
    const caption = captionInput.value.trim();

    for (const file of selectedFiles) {
      progressText.textContent = (done+1) + '/' + total + ' 업로드 중...';
      progressFill.style.width = (done / total * 100) + '%';

      try {
        // 1. Cloudinary에 직접 업로드
        const formData = new FormData();
        formData.append('file', file);
        formData.append('upload_preset', UPLOAD_PRESET);
        formData.append('folder', folder);
        formData.append('public_id', 'web_' + Date.now() + '_' + done);

        const resourceType = file.type.startsWith('video/') ? 'video' : 'image';
        const cloudRes = await fetch(
          'https://api.cloudinary.com/v1_1/' + CLOUD_NAME + '/' + resourceType + '/upload',
          { method: 'POST', body: formData }
        );

        if (!cloudRes.ok) throw new Error('Cloudinary: ' + cloudRes.status);
        const cloudData = await cloudRes.json();

        // 2. 서버에 Notion 저장 요청
        const notifyRes = await fetch('/api/upload/notify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            authorKakaoUserId: authorSelect.value,
            caption: caption,
            cloudinaryResult: {
              secure_url: cloudData.secure_url,
              public_id: cloudData.public_id,
              resource_type: cloudData.resource_type,
              width: cloudData.width,
              height: cloudData.height,
              duration: cloudData.duration,
              bytes: cloudData.bytes,
              eager: cloudData.eager,
            },
          }),
        });
        if (!notifyRes.ok) throw new Error('Notion: ' + notifyRes.status);
        success++;
      } catch (err) {
        console.error('Upload failed:', file.name, err);
      }
      done++;
    }

    progressFill.style.width = '100%';
    progressText.textContent = '완료!';

    resultDiv.style.display = 'block';
    resultDiv.innerHTML = '<div class="result-success">' + success + '/' + total + '개 저장 완료 🎉</div>'
      + '<a class="result-link" href="/album/' + month + '">앨범에서 보기 →</a>';

    selectedFiles = [];
    previewGrid.innerHTML = '';
    captionInput.value = '';
    captionInput.style.display = 'none';
    uploadBtn.textContent = '업로드';
  });
})();
</script>
</body>
</html>`;
}
