/**
 * Query history slide-over helpers for the Alpine root store (Chunk 7).
 */
window.MysqlClientQueryHistory = {
  STORAGE_TZ: 'mysqlStudio.historyTimeUtc',

  state() {
    const stored = localStorage.getItem(this.STORAGE_TZ);
    return {
      // SQLite datetime('now') is UTC — default display matches stored values.
      historyTimeUtc: stored === null ? true : stored === '1',
    };
  },

  methods: {
    openHistoryPanel() {
      this.historyOpen = true;
      void this.loadHistory();
    },

    closeHistoryPanel() {
      this.historyOpen = false;
    },

    toggleHistoryTimeZone() {
      this.historyTimeUtc = !this.historyTimeUtc;
      localStorage.setItem(
        window.MysqlClientQueryHistory.STORAGE_TZ,
        this.historyTimeUtc ? '1' : '0'
      );
    },

    /**
     * Format history timestamps as 24h `YYYY-MM-DD HH:mm:ss` in UTC or local.
     * SQLite `datetime('now')` values are treated as UTC.
     */
    formatHistoryTime(createdAt) {
      const raw = String(createdAt || '').trim();
      if (!raw) return '';

      let date;
      if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(raw)) {
        const normalized = raw.replace(' ', 'T');
        const hasZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(normalized);
        date = new Date(hasZone ? normalized : `${normalized}Z`);
      } else {
        date = new Date(raw);
      }
      if (Number.isNaN(date.getTime())) return raw;

      const pad = (n) => String(n).padStart(2, '0');
      const useUtc = this.historyTimeUtc !== false;
      const y = useUtc ? date.getUTCFullYear() : date.getFullYear();
      const mo = useUtc ? date.getUTCMonth() + 1 : date.getMonth() + 1;
      const d = useUtc ? date.getUTCDate() : date.getDate();
      const h = useUtc ? date.getUTCHours() : date.getHours();
      const mi = useUtc ? date.getUTCMinutes() : date.getMinutes();
      const s = useUtc ? date.getUTCSeconds() : date.getSeconds();
      return `${y}-${pad(mo)}-${pad(d)} ${pad(h)}:${pad(mi)}:${pad(s)}`;
    },

    async loadHistory() {
      this.historyLoading = true;
      try {
        const params = new URLSearchParams();
        if (this.activeConnectionId != null) {
          params.set('connectionId', String(this.activeConnectionId));
        }
        params.set('limit', '100');
        const data = await this.api('GET', `/api/history?${params}`);
        this.historyItems = data.items || [];
      } catch (err) {
        this.toast(err.message || 'Failed to load history', 'error');
      } finally {
        this.historyLoading = false;
      }
    },

    historyPreview(sql) {
      const text = String(sql || '').replace(/\s+/g, ' ').trim();
      return text.length > 140 ? `${text.slice(0, 140)}…` : text;
    },

    async deleteHistoryItem(id) {
      try {
        await this.api('DELETE', `/api/history/${id}`);
        this.historyItems = this.historyItems.filter((item) => item.id !== id);
        this.toast('History entry removed', 'info');
      } catch (err) {
        this.toast(err.message || 'Failed to delete', 'error');
      }
    },

    async clearHistory() {
      if (!this.activeConnectionId) {
        this.toast('Connect a session first', 'error');
        return;
      }
      const ok = window.confirm(
        'Clear query history for this connection? This cannot be undone.'
      );
      if (!ok) return;
      try {
        await this.api(
          'DELETE',
          `/api/history?connectionId=${encodeURIComponent(this.activeConnectionId)}`
        );
        this.historyItems = [];
        this.toast('History cleared', 'success');
      } catch (err) {
        this.toast(err.message || 'Failed to clear history', 'error');
      }
    },

    /**
     * Put the SQL into the active editor tab and optionally re-run it.
     */
    async useHistorySql(item, { run = false } = {}) {
      if (!item?.sql_text) return;
      if (!this.activeSession) {
        this.toast('Connect a session first', 'error');
        return;
      }

      this.setEditorMode?.('sql');
      await this.$nextTick();

      let tab = this.activeQueryTab?.();
      if (!tab) {
        this.addQueryTab?.();
        tab = this.activeQueryTab?.();
      }
      if (!tab) return;

      tab.sql = item.sql_text;
      tab.dirty = this.tabIsDirty?.(tab) ?? true;
      tab.error = null;

      const mod = window.MysqlClientQueryEditor;
      if (mod?.cm) {
        mod.syncing = true;
        mod.cm.setValue(item.sql_text);
        mod.syncing = false;
        mod.cm.focus();
      }

      this.historyOpen = false;
      if (run) {
        // Run the whole history statement as a selection so multi-statement
        // entries execute exactly as recorded.
        if (mod?.cm) {
          mod.cm.setSelection(
            { line: 0, ch: 0 },
            mod.cm.posFromIndex(item.sql_text.length)
          );
        }
        await this.executeSql?.();
      } else {
        this.toast('SQL loaded into editor', 'info');
      }
    },
  },
};
