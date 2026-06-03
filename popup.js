// YouTube Task-Inject Popup Logic

document.addEventListener('DOMContentLoaded', () => {
  const taskForm = document.getElementById('task-form');
  const taskInput = document.getElementById('task-input');
  const taskList = document.getElementById('task-list');
  const emptyState = document.getElementById('empty-state');
  const taskCountEl = document.getElementById('task-count');
  const statusBadge = document.getElementById('status-badge');

  // タスクの読み込みとレンダリング
  function loadTasks() {
    chrome.storage.local.get({ tasks: [] }, (result) => {
      renderTasks(result.tasks);
    });
  }

  // タスクリストのレンダリング
  function renderTasks(tasks) {
    taskList.innerHTML = '';
    const activeTasks = tasks.filter(t => !t.completed);
    
    // タスク数カウンターの更新
    taskCountEl.textContent = activeTasks.length;

    // ステータスバッジの更新
    updateStatusBadge(activeTasks.length);

    if (tasks.length === 0) {
      emptyState.style.display = 'flex';
      taskList.style.display = 'none';
      return;
    }

    emptyState.style.display = 'none';
    taskList.style.display = 'flex';

    // 未完了タスクを上に、完了タスクを下に並べ替えて表示
    const sortedTasks = [...tasks].sort((a, b) => a.completed - b.completed || b.createdAt - a.createdAt);

    sortedTasks.forEach(task => {
      const li = document.createElement('li');
      li.className = 'task-item';
      li.dataset.id = task.id;

      li.innerHTML = `
        <label class="task-checkbox-wrapper">
          <input type="checkbox" class="task-toggle" ${task.completed ? 'checked' : ''}>
          <span class="custom-checkbox"></span>
          <span class="task-text">${escapeHtml(task.text)}</span>
        </label>
        <button class="delete-btn" title="タスクを削除">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            <line x1="10" y1="11" x2="10" y2="17"></line>
            <line x1="14" y1="11" x2="14" y2="17"></line>
          </svg>
        </button>
      `;

      // イベントリスナーの追加
      const toggle = li.querySelector('.task-toggle');
      toggle.addEventListener('change', (e) => {
        toggleTaskComplete(task.id, e.target.checked);
      });

      const deleteBtn = li.querySelector('.delete-btn');
      deleteBtn.addEventListener('click', () => {
        // アニメーション付きで削除
        li.style.animation = 'slideOut 0.2s ease forwards';
        setTimeout(() => {
          deleteTask(task.id);
        }, 200);
      });

      taskList.appendChild(li);
    });
  }

  // ステータスバッジの表示変更
  function updateStatusBadge(count) {
    statusBadge.className = 'status-badge';
    if (count === 0) {
      statusBadge.textContent = 'タスクなし';
    } else if (count >= 1 && count <= 2) {
      statusBadge.textContent = 'フォーカス中 (低圧)';
      statusBadge.classList.add('active');
    } else if (count >= 3 && count <= 5) {
      statusBadge.textContent = 'フォーカス中 (中圧)';
      statusBadge.classList.add('active');
    } else {
      statusBadge.textContent = 'プレッシャー最大！';
      statusBadge.classList.add('alert');
    }
  }

  // 新規タスク追加
  taskForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = taskInput.value.trim();
    if (!text) return;

    chrome.storage.local.get({ tasks: [] }, (result) => {
      const tasks = result.tasks;
      const newTask = {
        id: 'task_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
        text: text,
        completed: false,
        createdAt: Date.now()
      };
      
      tasks.push(newTask);
      chrome.storage.local.set({ tasks }, () => {
        taskInput.value = '';
        loadTasks();
      });
    });
  });

  // タスクの完了状態トグル
  function toggleTaskComplete(id, completed) {
    chrome.storage.local.get({ tasks: [] }, (result) => {
      const tasks = result.tasks.map(task => {
        if (task.id === id) {
          return { ...task, completed };
        }
        return task;
      });

      chrome.storage.local.set({ tasks }, () => {
        loadTasks();
      });
    });
  }

  // タスク削除
  function deleteTask(id) {
    chrome.storage.local.get({ tasks: [] }, (result) => {
      const tasks = result.tasks.filter(task => task.id !== id);
      chrome.storage.local.set({ tasks }, () => {
        loadTasks();
      });
    });
  }

  // HTMLエスケープ (XSS対策)
  function escapeHtml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // 外部からの更新（content script等でのタスク変更）をリッスンして同期
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.tasks) {
      renderTasks(changes.tasks.newValue || []);
    }
  });

  // 初期ロード
  loadTasks();
});

// 削除時のスライドアウトアニメーションの定義を追加するための動的CSSインジェクション
const style = document.createElement('style');
style.textContent = `
  @keyframes slideOut {
    from { opacity: 1; transform: translateY(0); }
    to { opacity: 0; transform: translateY(-8px); height: 0; padding-top: 0; padding-bottom: 0; margin-top: 0; margin-bottom: 0; border: none; }
  }
`;
document.head.appendChild(style);
