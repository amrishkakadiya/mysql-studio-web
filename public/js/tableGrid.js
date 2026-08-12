/**
 * Table data grid helpers for the Alpine root store.
 * Loaded before app.js and mixed into mysqlClient().
 */
window.MysqlClientTableGrid = {
  MIN_PAGE_LIMIT: 1,
  MAX_PAGE_LIMIT: 1000,

  blankTableView() {
    return {
      database: null,
      table: null,
      columns: [],
      rows: [],
      rowCount: 0,
      durationMs: null,
      limited: false,
      sql: '',
      loading: false,
      loadingMore: false,
      error: null,
      sortColumn: null,
      sortDir: 'asc',
      filterColumn: '',
      filterValue: '',
      offset: 0,
      limit: 100,
      limitInput: '100',
      configLimit: 100,
      // Page size the rows on screen were actually fetched with.
      loadedLimit: null,
      hasMore: false,
      requestId: 0,
      filterTimer: null,
      limitTimer: null,
      // Chunk 7 inspector: data | columns | indexes | ddl
      inspectorTab: 'data',
      meta: null,
    };
  },

  /** Returns null for blank / non-numeric / non-positive input so partial typing is ignored. */
  clampLimit(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return null;
    const num = Math.round(Number(raw));
    if (!Number.isFinite(num) || num < 1) return null;
    return Math.min(this.MAX_PAGE_LIMIT, Math.max(this.MIN_PAGE_LIMIT, num));
  },

  methods: {
    activeTableView() {
      return this.activeSession?.tableView || null;
    },

    gridRows() {
      const view = this.activeTableView();
      return view && Array.isArray(view.rows) ? view.rows : [];
    },

    ensureTableView(session) {
      if (!session.tableView) {
        session.tableView = window.MysqlClientTableGrid.blankTableView();
      }
      return session.tableView;
    },

    formatCell(value) {
      if (value === null || value === undefined) return 'NULL';
      if (typeof value === 'object') {
        try {
          return JSON.stringify(value);
        } catch (_) {
          return String(value);
        }
      }
      return String(value);
    },

    isNullCell(value) {
      return value === null || value === undefined;
    },

    async sortGridBy(column) {
      const view = this.activeTableView();
      if (!view) return;
      if (view.sortColumn === column) {
        view.sortDir = view.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        view.sortColumn = column;
        view.sortDir = 'asc';
      }
      await this.loadTablePage({ reset: true });
    },

    sortIndicator(column) {
      const view = this.activeTableView();
      if (!view || view.sortColumn !== column) return '';
      return view.sortDir === 'asc' ? ' ↑' : ' ↓';
    },

    clearTableView() {
      const session = this.activeSession;
      if (!session) return;
      const view = session.tableView;
      if (view) {
        clearTimeout(view.filterTimer);
        clearTimeout(view.limitTimer);
      }
      session.tableView = window.MysqlClientTableGrid.blankTableView();
    },

    /** Resets sort, filter and page size back to the connection defaults. */
    async resetTableView() {
      const view = this.activeTableView();
      if (!view?.database || !view?.table) return;
      clearTimeout(view.filterTimer);
      clearTimeout(view.limitTimer);
      view.sortColumn = null;
      view.sortDir = 'asc';
      view.filterColumn = '';
      view.filterValue = '';
      view.limit = view.configLimit;
      view.limitInput = String(view.configLimit);
      await this.loadTablePage({ reset: true });
    },

    hasGridAdjustments() {
      const view = this.activeTableView();
      if (!view) return false;
      return Boolean(view.sortColumn)
        || Boolean(view.filterColumn)
        || Boolean(view.filterValue)
        || view.limit !== view.configLimit;
    },

    async openTableView(connectionId, databaseName, tableName) {
      const id = Number(connectionId);
      if (!this.isOpen(id)) {
        this.toast('Connect first', 'error');
        return;
      }

      this.selectDatabase(id, databaseName);
      this.selectedConnectionId = id;
      this.activeConnectionId = id;
      const tree = this.ensureTree?.(id);
      if (tree) tree.selectedObject = null;

      const session = this.sessions[id];
      session.viewMode = 'table';
      const view = this.ensureTableView(session);
      view.loading = true;
      view.error = null;
      view.database = databaseName;
      view.table = tableName;
      view.sortColumn = null;
      view.sortDir = 'asc';
      view.filterColumn = '';
      view.filterValue = '';
      view.rows = [];
      view.columns = [];
      view.inspectorTab = 'data';
      view.meta = null;
      clearTimeout(view.filterTimer);
      clearTimeout(view.limitTimer);
      view.configLimit = Number(session.connection.row_limit) || 100;
      view.limit = view.configLimit;
      view.limitInput = String(view.configLimit);
      view.loadedLimit = null;
      await this.loadTablePage({ reset: true });
    },

    async loadTablePage({ reset = false } = {}) {
      const view = this.activeTableView();
      const session = this.activeSession;
      if (!view?.database || !view?.table || !session) return;
      if (!reset && (view.loading || view.loadingMore || !view.hasMore)) return;

      if (reset) {
        view.requestId += 1;
        view.offset = 0;
        view.rows = [];
        view.hasMore = false;
        view.loading = true;
        view.loadingMore = false;
        view.error = null;
      } else {
        view.loadingMore = true;
      }
      const requestId = view.requestId;

      try {
        const data = await this.api('POST', '/api/query/table', {
          connectionId: session.connection.id,
          database: view.database,
          table: view.table,
          offset: reset ? 0 : view.offset,
          limit: view.limit,
          sortColumn: view.sortColumn,
          sortDir: view.sortDir,
          filterColumn: view.filterColumn || null,
          filterValue: view.filterValue,
        });
        if (requestId !== view.requestId) return;

        view.columns = data.columns || view.columns;
        view.rows = reset ? (data.rows || []) : view.rows.concat(data.rows || []);
        view.offset = view.rows.length;
        view.rowCount = view.rows.length;
        if (data.configuredLimit) view.configLimit = data.configuredLimit;
        view.loadedLimit = Number(data.limit) || view.limit;
        view.hasMore = Boolean(data.hasMore);
        view.durationMs = data.durationMs ?? null;
        view.limited = Boolean(data.limited);
        view.sql = data.sql || '';
      } catch (err) {
        if (requestId !== view.requestId) return;
        view.loadedLimit = null;
        view.error = err.message || 'Failed to load table';
        this.toast(view.error, 'error');
      } finally {
        if (requestId === view.requestId) {
          view.loading = false;
          view.loadingMore = false;
        }
      }
    },

    onGridScroll(event) {
      const element = event.currentTarget;
      if (element.scrollHeight - element.scrollTop - element.clientHeight < 160) {
        void this.loadTablePage();
      }
    },

    setFilterColumn(column) {
      const view = this.activeTableView();
      if (!view || view.filterColumn === column) return;
      const wasFiltering = Boolean(view.filterColumn && view.filterValue);
      clearTimeout(view.filterTimer);
      view.filterColumn = column;
      view.filterValue = '';
      if (wasFiltering) void this.loadTablePage({ reset: true });
    },

    setFilterValue(value) {
      const view = this.activeTableView();
      if (!view) return;
      view.filterValue = value;
      clearTimeout(view.filterTimer);
      view.filterTimer = setTimeout(() => {
        void this.loadTablePage({ reset: true });
      }, 350);
    },

    /**
     * Page size override typed by the user. Debounced, and only affects this
     * table view — the connection's configured row limit stays untouched.
     */
    setPageLimit(value) {
      const view = this.activeTableView();
      if (!view) return;
      view.limitInput = value;
      clearTimeout(view.limitTimer);
      // Wait for a complete value; blank/partial input is committed on blur instead.
      if (window.MysqlClientTableGrid.clampLimit(value) === null) return;
      view.limitTimer = setTimeout(() => {
        this.applyPageLimit(view.limitInput, view);
      }, 500);
    },

    /** Commit on Enter / blur / spinner without waiting for the debounce. */
    commitPageLimit(value) {
      const view = this.activeTableView();
      if (!view) return;
      clearTimeout(view.limitTimer);
      this.applyPageLimit(value, view, { restoreInvalid: true });
    },

    /**
     * Applies a page size to `sourceView` and reloads it. The reload is keyed on
     * the limit the visible rows were fetched with, so a view whose limit drifted
     * out of sync (session switched mid-debounce) still re-queries instead of
     * silently keeping the old page size.
     */
    applyPageLimit(value, sourceView, { restoreInvalid = false } = {}) {
      const view = this.activeTableView();
      // The active view moved on while typing — don't mutate a detached view.
      if (!view || (sourceView && view !== sourceView)) return;

      const next = window.MysqlClientTableGrid.clampLimit(value);
      if (next === null) {
        if (restoreInvalid) view.limitInput = String(view.limit);
        return;
      }

      view.limitInput = String(next);
      const alreadyApplied = next === view.limit && next === view.loadedLimit;
      view.limit = next;
      if (alreadyApplied) return;
      void this.loadTablePage({ reset: true });
    },

    async reloadTableView() {
      const view = this.activeTableView();
      if (!view?.database || !view?.table) return;
      await this.loadTablePage({ reset: true });
    },
  },
};
