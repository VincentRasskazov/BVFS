const HISTORY_KEY = 'bvfs_shell_history';
let history = [];
let cursor = 0;

export function loadHistory() {
    try {
        const stored = localStorage.getItem(HISTORY_KEY);
        if (stored) history = JSON.parse(stored);
        cursor = history.length;
    } catch (e) {
        history = [];
    }
}

export function pushHistory(cmd) {
    if (!cmd || cmd === history[history.length - 1]) return;
    history.push(cmd);
    if (history.length > 1000) history.shift(); // Cap at 1000 entries
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    cursor = history.length;
}

export function getPrevious() {
    if (cursor > 0) cursor--;
    return history[cursor] || '';
}

export function getNext() {
    if (cursor < history.length - 1) {
        cursor++;
        return history[cursor];
    }
    cursor = history.length;
    return '';
}

export function getFullHistory() {
    return history;
}
