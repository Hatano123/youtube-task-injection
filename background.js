// YouTube Task-Inject Background Service Worker

// 外部のYouTube検索結果を取得して動画情報を抽出する
async function searchYouTube(query) {
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    const html = await response.text();
    
    let jsonStr = '';
    // ytInitialDataを抽出するパターン
    const patterns = [
      /ytInitialData\s*=\s*({.+?});\s*(?:<\/script>|window|var)/s,
      /ytInitialData\s*=\s*({.+?});/s,
      /window\["ytInitialData"\]\s*=\s*({.+?});/s
    ];
    
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match) {
        jsonStr = match[1];
        break;
      }
    }
    
    if (!jsonStr) {
      // 代替手段として、より簡易的なマッチングを試みる
      const fallbackMatch = html.match(/ytInitialData\s*=\s*({.+?})</s);
      if (fallbackMatch) {
        jsonStr = fallbackMatch[1];
      }
    }
    
    if (!jsonStr) {
      console.error('ytInitialData not found in HTML response');
      return [];
    }
    
    // JSONの末尾が正しく閉じられていない場合のクリーンアップ
    // (稀にスクリプトタグや他の変数が混ざることがあるため)
    try {
      // 最初の波括弧の対を見つける
      let braceCount = 0;
      let endIdx = 0;
      for (let i = 0; i < jsonStr.length; i++) {
        if (jsonStr[i] === '{') braceCount++;
        else if (jsonStr[i] === '}') {
          braceCount--;
          if (braceCount === 0) {
            endIdx = i;
            break;
          }
        }
      }
      if (endIdx > 0) {
        jsonStr = jsonStr.substring(0, endIdx + 1);
      }
    } catch (e) {
      console.warn('JSON brackets balancing failed, using raw string', e);
    }
    
    const data = JSON.parse(jsonStr);
    
    // 検索結果のパスをたどる
    const contents = data.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents;
    if (!contents || !Array.isArray(contents)) {
      console.error('Invalid search results structure');
      return [];
    }
    
    const videos = [];
    for (const section of contents) {
      const itemSection = section.itemSectionRenderer;
      if (!itemSection || !Array.isArray(itemSection.contents)) continue;
      
      for (const item of itemSection.contents) {
        if (item.videoRenderer) {
          const vr = item.videoRenderer;
          const videoId = vr.videoId;
          const title = vr.title?.runs?.[0]?.text || vr.title?.simpleText || '';
          const channelName = vr.ownerText?.runs?.[0]?.text || '';
          
          // サムネイルは高解像度があればそれを使う
          const thumbnails = vr.thumbnail?.thumbnails || [];
          const thumbnailUrl = thumbnails[thumbnails.length - 1]?.url || thumbnails[0]?.url || '';
          
          const viewCountText = vr.viewCountText?.simpleText || vr.shortViewCountText?.simpleText || '';
          const publishedTimeText = vr.publishedTimeText?.simpleText || '';
          const lengthText = vr.lengthText?.simpleText || '';
          
          if (videoId && title) {
            videos.push({
              videoId,
              title,
              channelName,
              thumbnailUrl,
              viewCountText,
              publishedTimeText,
              lengthText
            });
          }
        }
      }
    }
    
    return videos;
  } catch (error) {
    console.error('Error in searchYouTube:', error);
    return [];
  }
}

// メッセージパッシングの処理
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'search_videos') {
    searchYouTube(request.query)
      .then(videos => {
        sendResponse({ success: true, videos });
      })
      .catch(error => {
        sendResponse({ success: false, error: error.message });
      });
    return true; // 非同期でレスポンスを返すために true を返す
  }
});
