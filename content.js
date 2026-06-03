// YouTube Task-Inject Content Script

(function () {
  'use strict';

  // グローバル変数と設定
  let activeTasks = [];
  let videoPool = [];
  let videoCache = {}; // 検索キーワードごとの動画キャッシュ
  let itemIndex = 0;   // インジェクション処理用のカウンタ
  let observer = null; // MutationObserver インスタンス
  let isSearching = false; // 重複検索防止フラグ
  let isManipulatingDOM = false; // DOM操作中のフラグ（無限ループ防止）
  let unprocessedItemsStore = []; // 未処理アイテムの一時保存バッファ

  // 拡張機能のコンテキストが有効であるかチェックする関数
  function isContextValid() {
    return typeof chrome !== 'undefined' && chrome.runtime && !!chrome.runtime.id;
  }


  // デバッグ用ログ
  function log(...args) {
    console.log('[YouTube Task-Inject]', ...args);
  }

  // 初期化処理
  function init() {
    log('Initializing extension...');
    
    // イベントリスナー登録 (YouTubeのSPA遷移に対応)
    window.addEventListener('yt-navigate-finish', handleNavigation);
    
    // 初回起動
    handleNavigation();

    // ストレージの変更を監視 (ポップアップ等での変更をリアルタイム反映)
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (!isContextValid()) return;
        if (areaName === 'local' && changes.tasks) {
          log('Tasks updated in storage');
          // タスクが変更されたら一旦すべてのインジェクションをリセットし、再適用する
          updateTasksAndReapply(changes.tasks.newValue || []);
        }
      });
    }
  }

  // ページ遷移ハンドラ
  function handleNavigation() {
    if (!isContextValid()) {
      // コンテキストが無効な場合はイベントリスナーを解除して自己消滅
      window.removeEventListener('yt-navigate-finish', handleNavigation);
      return;
    }

    const isTargetPage = window.location.pathname === '/' || 
                         window.location.pathname === '/index.html' ||
                         window.location.pathname === '/watch';
    
    if (isTargetPage) {
      log('On target page, starting observer');
      startObserver();
      // タスクを読み込んでインジェクションを初期適用
      chrome.storage.local.get({ tasks: [] }, (result) => {
        if (!isContextValid()) return;
        updateTasksAndReapply(result.tasks);
      });
    } else {
      log('Not on target page, stopping observer');
      stopObserver();
      resetInjections();
    }
  }

  // タスク情報を更新し、インジェクションを再適用する
  async function updateTasksAndReapply(tasks) {
    if (!isContextValid()) return;
    isManipulatingDOM = true;
    activeTasks = tasks;
    
    // 学習動画プールの更新
    await refreshVideoPool();
    
    if (!isContextValid()) {
      isManipulatingDOM = false;
      return;
    }
    
    // 既存のインジェクションを一度クリア
    resetInjections();
    
    // 新しい状態に沿って再適用
    applyInjectionToExistingElements();
    isManipulatingDOM = false;
  }

  // 未完了タスクをもとに動画プールを構築
  async function refreshVideoPool() {
    if (!isContextValid()) return;
    const uncompletedTasks = activeTasks.filter(t => !t.completed);
    
    if (uncompletedTasks.length === 0) {
      videoPool = [];
      return;
    }

    if (isSearching) return;
    isSearching = true;

    try {
      const allTaskVideos = [];
      
      for (const task of uncompletedTasks) {
        const query = task.text;
        
        // キャッシュにあればそれを使用
        if (videoCache[query]) {
          allTaskVideos.push(...videoCache[query]);
          continue;
        }

        // キャッシュになければbackgroundに検索を依頼
        log(`Requesting search for: "${query}"`);
        let response = null;
        try {
          response = await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage(
              { action: 'search_videos', query: query },
              (res) => {
                if (chrome.runtime.lastError) {
                  reject(chrome.runtime.lastError);
                } else {
                  resolve(res);
                }
              }
            );
          });
        } catch (err) {
          log('Failed to send message to background:', err);
        }

        if (response && response.success && response.videos && response.videos.length > 0) {
          log(`Found ${response.videos.length} videos for "${query}"`);
          videoCache[query] = response.videos;
          allTaskVideos.push(...response.videos);
        } else {
          log(`No videos found or error for "${query}"`);
        }
      }

      // 取得した動画をシャッフルまたは交互にマージしてプールに格納
      videoPool = shuffleArray(allTaskVideos);
      
    } catch (e) {
      console.error('Error refreshing video pool:', e);
    } finally {
      isSearching = false;
    }
  }

  // 配列のシャッフル (動画サジェストをランダムにするため)
  function shuffleArray(array) {
    const newArray = [...array];
    for (let i = newArray.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [newArray[i], newArray[j]] = [newArray[j], newArray[i]];
    }
    return newArray;
  }

  // MutationObserver の開始
  function startObserver() {
    if (observer) observer.disconnect();

    observer = new MutationObserver((mutations) => {
      if (!isContextValid()) {
        // コンテキストが無効な場合は監視を解除して自己消滅
        if (observer) observer.disconnect();
        return;
      }
      if (isManipulatingDOM) return; // 拡張機能自体のDOM操作中は無視

      let shouldProcess = false;
      for (const mutation of mutations) {
        if (mutation.addedNodes.length > 0) {
          // 拡張機能が追加したラッパーは監視対象外とする
          let hasRealAddedNode = false;
          mutation.addedNodes.forEach(node => {
            if (node.nodeType === Node.ELEMENT_NODE && 
                !node.classList.contains('task-inject-wrapper') &&
                !node.classList.contains('ti-panel') &&
                !node.classList.contains('ti-video-card') &&
                !node.classList.contains('ti-compact')) {
              hasRealAddedNode = true;
            }
          });
          if (hasRealAddedNode) {
            shouldProcess = true;
            break;
          }
        }
      }
      if (shouldProcess) {
        applyInjectionToExistingElements();
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  // MutationObserver の停止
  function stopObserver() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
  }

  // インジェクションのリセット（元の表示に戻す）
  function resetInjections() {
    log('Resetting injections...');
    itemIndex = 0;
    unprocessedItemsStore = []; // 未処理プールをクリア
    
    // インジェクトした要素をすべて削除
    const injectedWrappers = document.querySelectorAll('.task-inject-wrapper');
    injectedWrappers.forEach(el => el.remove());

    // 非表示にしていた元の動画コンテンツを再表示
    const originalContents = document.querySelectorAll('[data-ti-hidden="true"]');
    originalContents.forEach(el => {
      el.style.display = '';
      el.removeAttribute('data-ti-hidden');
    });

    // 処理済みマーク属性を解除
    const processedItems = document.querySelectorAll('[data-ti-processed]');
    processedItems.forEach(el => el.removeAttribute('data-ti-processed'));
  }

  // タスク数に応じたインジェクション比率（何個に1個を書き換えるか）の決定
  function getInjectionRatio() {
    const activeCount = activeTasks.filter(t => !t.completed).length;
    
    if (activeCount === 0) {
      return 9; // タスクなし時：9個に1個
    } else if (activeCount >= 1 && activeCount <= 2) {
      return 9; // タスク1〜2個：9個に1個
    } else if (activeCount >= 3 && activeCount <= 5) {
      return 6; // タスク3〜5個：6個に1個
    } else {
      return 3; // タスク6個以上：3個に1個 (高プレッシャー)
    }
  }

  // DOMをスキャンし、対象となる動画要素をハックする
  function applyInjectionToExistingElements() {
    if (!isContextValid()) return;
    const isTargetPage = window.location.pathname === '/' || 
                         window.location.pathname === '/index.html' ||
                         window.location.pathname === '/watch';
    if (!isTargetPage) return;

    // ホームのグリッド要素、および再生画面のサイドバー関連動画要素を取得
    const richItems = document.querySelectorAll('ytd-rich-item-renderer');
    const compactItems = document.querySelectorAll('ytd-compact-video-renderer');
    
    if (richItems.length === 0 && compactItems.length === 0) return;

    isManipulatingDOM = true;

    const ratio = getInjectionRatio();
    const uncompletedTasks = activeTasks.filter(t => !t.completed);

    // 新しく検出された未処理の要素をプールに追加
    const newUnprocessedItems = [];
    const allItems = [...richItems, ...compactItems];

    allItems.forEach((item) => {
      if (item.hasAttribute('data-ti-processed')) {
        return;
      }

      // ホーム画面は #content、サイドバーは #dismissible が元の動画要素
      const originalContent = item.querySelector('#content') || item.querySelector('#dismissible');
      if (!originalContent) {
        item.setAttribute('data-ti-processed', 'skipped');
        return;
      }
      newUnprocessedItems.push(item);
    });

    unprocessedItemsStore.push(...newUnprocessedItems);

    // プール内の要素数が ratio 個以上ある限り、ブロックごとにランダム位置にインジェクトする
    while (unprocessedItemsStore.length >= ratio) {
      const block = unprocessedItemsStore.splice(0, ratio);
      const targetIndex = Math.floor(Math.random() * ratio);

      block.forEach((item, index) => {
        const originalContent = item.querySelector('#content') || item.querySelector('#dismissible');
        if (index === targetIndex) {
          // インジェクションを実行
          item.setAttribute('data-ti-processed', 'injected');
          originalContent.style.display = 'none';
          originalContent.setAttribute('data-ti-hidden', 'true');

          const isCompact = item.tagName.toLowerCase() === 'ytd-compact-video-renderer';

          const wrapper = document.createElement('div');
          wrapper.className = 'task-inject-wrapper' + (isCompact ? ' ti-compact' : '');
          item.appendChild(wrapper);

          // タスクが未設定、またはインジェクト対象枠の3回に1回はタスクパネルを挿入する
          itemIndex++;
          const showPanel = uncompletedTasks.length === 0 || (itemIndex % 3 === 0);

          if (showPanel) {
            renderTaskPanel(wrapper, isCompact);
          } else {
            renderSuggestedVideo(wrapper, isCompact);
          }
        } else {
          // 通常表示として処理済みマークを付与
          item.setAttribute('data-ti-processed', 'normal');
        }
      });
    }

    isManipulatingDOM = false;
  }

  // タスク管理パネルのレンダリング
  function renderTaskPanel(container, isCompact = false) {
    const uncompletedTasks = activeTasks.filter(t => !t.completed);

    const panel = document.createElement('div');
    panel.className = 'ti-panel' + (isCompact ? ' ti-compact' : '');

    if (uncompletedTasks.length === 0) {
      // 1. タスク未設定時の表示
      panel.innerHTML = `
        <div class="ti-panel-header">
          <span class="ti-panel-title">🎯 YouTube Task-Inject</span>
        </div>
        <div class="ti-empty-container">
          <div class="ti-empty-icon">💡</div>
          <div class="ti-empty-text">現在のタスクがありません。<br>まずはタスクの洗い出しをしましょう</div>
          <div class="ti-empty-subtext">ダラダラ見を防ぐため、1つ登録してみましょう！</div>
          <form class="ti-input-form">
            <input type="text" class="ti-input" placeholder="例: 応用情報技術者試験 過去問" required autocomplete="off">
            <button type="submit" class="ti-submit-btn">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <line x1="12" y1="5" x2="12" y2="19"></line>
                <line x1="5" y1="12" x2="19" y2="12"></line>
              </svg>
            </button>
          </form>
        </div>
      `;

      // フォームイベント登録
      const form = panel.querySelector('.ti-input-form');
      const input = panel.querySelector('.ti-input');
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const text = input.value.trim();
        if (!text) return;
        addTask(text);
      });

    } else {
      // 2. タスク設定時の表示
      const badgeText = uncompletedTasks.length >= 6 ? 'プレッシャー最大！' : `${uncompletedTasks.length} 個のタスク`;
      
      panel.innerHTML = `
        <div class="ti-panel-header">
          <span class="ti-panel-title">🎯 フォーカスタスク</span>
          <span class="ti-panel-badge">${badgeText}</span>
        </div>
        <ul class="ti-task-list">
          <!-- タスク項目を挿入 -->
        </ul>
        <form class="ti-input-form" style="margin-top: auto; padding-top: 12px; border-top: 1px solid var(--ti-border);">
          <input type="text" class="ti-input" placeholder="タスクを追加..." required autocomplete="off">
          <button type="submit" class="ti-submit-btn">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
          </button>
        </form>
      `;

      const listEl = panel.querySelector('.ti-task-list');

      // タスクリストのレンダリング (最大表示数を制限せず、CSSでスクロール可能に)
      uncompletedTasks.forEach(task => {
        const li = document.createElement('li');
        li.className = 'ti-task-item';
        li.innerHTML = `
          <label class="ti-checkbox-label">
            <input type="checkbox" class="ti-checkbox" data-id="${task.id}">
            <span class="ti-custom-checkbox"></span>
            <span class="ti-task-text">${escapeHtml(task.text)}</span>
          </label>
        `;

        const checkbox = li.querySelector('.ti-checkbox');
        checkbox.addEventListener('change', (e) => {
          if (e.target.checked) {
            // アニメーションを待って完了
            li.style.opacity = '0.5';
            li.style.textDecoration = 'line-through';
            setTimeout(() => {
              completeTask(task.id);
            }, 300);
          }
        });

        listEl.appendChild(li);
      });

      // フォームイベント登録
      const form = panel.querySelector('.ti-input-form');
      const input = panel.querySelector('.ti-input');
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const text = input.value.trim();
        if (!text) return;
        addTask(text);
      });
    }

    container.appendChild(panel);
  }

  // 学習動画カードのレンダリング
  function renderSuggestedVideo(container, isCompact = false) {
    // プールから動画を取得
    const video = videoPool.pop();

    // 動画がプールにない場合（検索結果がまだ届いていない、または結果が0件の場合）はタスクパネルを代わりに表示
    if (!video) {
      renderTaskPanel(container, isCompact);
      return;
    }

    // 次回のために動画プールを再利用（プールの末尾に追加してループさせる）
    videoPool.unshift(video);

    const card = document.createElement('a');
    card.className = 'ti-video-card' + (isCompact ? ' ti-compact' : '');
    card.href = `/watch?v=${video.videoId}`;

    // チャンネル名の頭文字をアバターにする
    const avatarChar = video.channelName ? video.channelName.charAt(0).toUpperCase() : 'L';

    if (isCompact) {
      card.innerHTML = `
        <div class="ti-video-thumbnail-wrapper">
          <span class="ti-video-suggest-badge">学習サジェスト</span>
          <img class="ti-video-thumbnail" src="${video.thumbnailUrl}" alt="${escapeHtml(video.title)}">
          ${video.lengthText ? `<span class="ti-video-duration">${video.lengthText}</span>` : ''}
        </div>
        <div class="ti-video-details">
          <div class="ti-video-meta">
            <h3 class="ti-video-title" title="${escapeHtml(video.title)}">${escapeHtml(video.title)}</h3>
            <div class="ti-video-channel">${escapeHtml(video.channelName)}</div>
            <div class="ti-video-stats">
              <span>${escapeHtml(video.viewCountText)}</span>
              ${video.publishedTimeText ? `<span> • ${escapeHtml(video.publishedTimeText)}</span>` : ''}
            </div>
          </div>
        </div>
      `;
    } else {
      card.innerHTML = `
        <div class="ti-video-thumbnail-wrapper">
          <span class="ti-video-suggest-badge">学習サジェスト</span>
          <img class="ti-video-thumbnail" src="${video.thumbnailUrl}" alt="${escapeHtml(video.title)}">
          ${video.lengthText ? `<span class="ti-video-duration">${video.lengthText}</span>` : ''}
        </div>
        <div class="ti-video-details">
          <div class="ti-channel-avatar">${avatarChar}</div>
          <div class="ti-video-meta">
            <h3 class="ti-video-title" title="${escapeHtml(video.title)}">${escapeHtml(video.title)}</h3>
            <div class="ti-video-channel">${escapeHtml(video.channelName)}</div>
            <div class="ti-video-stats">
              <span>${escapeHtml(video.viewCountText)}</span>
              ${video.publishedTimeText ? `<span> • ${escapeHtml(video.publishedTimeText)}</span>` : ''}
            </div>
          </div>
        </div>
      `;
    }

    // 特別なクリックイベントの制御は行わず、デフォルトのaタグリンクとして動作させます。
    // YouTubeアプリのグローバルなクリックリスナーがSPA遷移を正しくハンドリングするため、
    // ここでカスタムイベント（yt-navigateなど）を発火すると内部エラーが発生するのを防ぎます。

    container.appendChild(card);
  }

  // タスク追加
  function addTask(text) {
    if (!isContextValid()) return;
    chrome.storage.local.get({ tasks: [] }, (result) => {
      if (!isContextValid()) return;
      const tasks = result.tasks;
      const newTask = {
        id: 'task_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
        text: text,
        completed: false,
        createdAt: Date.now()
      };
      
      tasks.push(newTask);
      chrome.storage.local.set({ tasks }, () => {
        log('Task added:', text);
      });
    });
  }

  // タスクの完了処理
  function completeTask(id) {
    if (!isContextValid()) return;
    chrome.storage.local.get({ tasks: [] }, (result) => {
      if (!isContextValid()) return;
      const tasks = result.tasks.map(task => {
        if (task.id === id) {
          return { ...task, completed: true };
        }
        return task;
      });

      chrome.storage.local.set({ tasks }, () => {
        log('Task completed:', id);
      });
    });
  }

  // HTMLエスケープ (安全対策)
  function escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // スクリプトの実行開始
  init();

})();
