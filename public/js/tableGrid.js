/**
 * Table data grid helpers for the Alpine root store.
 * Loaded before app.js and mixed into mysqlClient().
 */
window.MysqlClientTableGrid = {
  MIN_PAGE_LIMIT: 1,
  MAX_PAGE_LIMIT: 1000,
  // Keep the browser light: at most this many table grids cached per session.
  MAX_CACHED_TABLE_VIEWS: 3,
  // In-flight table fetches keyed by `${connectionId}:${db}.${table}`.
  // Held off Alpine-reactive state so AbortController isn't proxied.
  inflight: new Map(),

  blankTableView() {
    return {
      // Session-scoped cache key (`db.table`) and owning connection id.
      key: null,
      connectionId: null,
      lastActiveAt: 0,
      // Rows were trimmed to the first page while this view was inactive.
      trimmed: false,
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
      // Numeric stale-response guard (bumped on reset / cancel).
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
      const session = this.activeSession;
      if (!session || !session.activeTableKey) return null;
      return session.tableViews?.[session.activeTableKey] || null;
    },

    gridRows() {
      const view = this.activeTableView();
      return view && Array.isArray(view.rows) ? view.rows : [];
    },

    /** Global inflight-map key: connection-scoped so `db.table` can't collide. */
    tableInflightKey(view, session = this.activeSession) {
      const connId = view?.connectionId ?? session?.connection?.id;
      return `${connId}:${view?.key}`;
    },

    /**
     * Trim a background/inactive table down to its first page so we never hold
     * every scroll-loaded page of a table the user has left. The active table
     * keeps its full row set.
     */
    trimInactiveTableView(view) {
      if (!view || view.loading || view.loadingMore) return;
      const cap = Math.min(
        1000,
        Number(view.loadedLimit) || Number(view.configLimit) || 100
      );
      if (Array.isArray(view.rows) && view.rows.length > cap) {
        view.rows = view.rows.slice(0, cap);
        view.offset = view.rows.length;
        view.rowCount = view.rows.length;
        // The cut rows still exist server-side, so more pages remain.
        view.hasMore = true;
        view.trimmed = true;
      }
    },

    /** Evict least-recently-active finished tables beyond the cache cap. */
    enforceTableViewLimit(session) {
      const mod = window.MysqlClientTableGrid;
      const views = session.tableViews || {};
      if (Object.keys(views).length <= mod.MAX_CACHED_TABLE_VIEWS) return;
      const evictable = Object.keys(views)
        .filter((k) => k !== session.activeTableKey)
        .map((k) => views[k])
        .filter((v) => v && !v.loading && !v.loadingMore)
        .sort((a, b) => (a.lastActiveAt || 0) - (b.lastActiveAt || 0));
      for (const victim of evictable) {
        if (Object.keys(views).length <= mod.MAX_CACHED_TABLE_VIEWS) break;
        clearTimeout(victim.filterTimer);
        clearTimeout(victim.limitTimer);
        mod.inflight.delete(this.tableInflightKey(victim, session));
        delete views[victim.key];
      }
    },

    /** Abort every in-flight table load for a connection (on disconnect). */
    abortSessionTableLoads(connectionId) {
      const mod = window.MysqlClientTableGrid;
      const prefix = `${Number(connectionId)}:`;
      for (const [k, entry] of mod.inflight) {
        if (k.startsWith(prefix)) {
          try { entry.controller.abort(); } catch (_) { /* settled */ }
          mod.inflight.delete(k);
        }
      }
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
      const key = session.activeTableKey;
      const view = key ? session.tableViews?.[key] : null;
      if (view) {
        clearTimeout(view.filterTimer);
        clearTimeout(view.limitTimer);
        const mod = window.MysqlClientTableGrid;
        const gkey = this.tableInflightKey(view, session);
        const entry = mod.inflight.get(gkey);
        if (entry) {
          try { entry.controller.abort(); } catch (_) { /* settled */ }
          mod.inflight.delete(gkey);
          this.api('POST', '/api/query/cancel', {
            connectionId: entry.connectionId,
            requestId: entry.requestId,
          }).catch(() => {});
        }
        delete session.tableViews[key];
      }
      session.activeTableKey = null;
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
      if (!session.tableViews) session.tableViews = {};

      const mod = window.MysqlClientTableGrid;
      const key = `${databaseName}.${tableName}`;
      const previousKey = session.activeTableKey;
      let view = session.tableViews[key];

      if (!view) {
        view = mod.blankTableView();
        view.key = key;
        view.connectionId = id;
        view.database = databaseName;
        view.table = tableName;
        view.configLimit = Number(session.connection.row_limit) || 100;
        view.limit = view.configLimit;
        view.limitInput = String(view.configLimit);
        session.tableViews[key] = view;
      }

      // Activate this table; free the one we just left and enforce the cap.
      session.activeTableKey = key;
      view.lastActiveAt = Date.now();
      if (previousKey && previousKey !== key) {
        this.trimInactiveTableView(session.tableViews[previousKey]);
      }
      this.enforceTableViewLimit(session);

      // A load already running for this table — just show it, don't restart.
      if (view.loading || view.loadingMore || mod.inflight.has(this.tableInflightKey(view, session))) {
        return;
      }
      // Cached rows are still valid (trim keeps a scrollable first page).
      if (Array.isArray(view.rows) && view.rows.length && !view.error) {
        return;
      }

      // Fresh (or trimmed-away / errored) — reset and load page 1.
      view.inspectorTab = 'data';
      view.sortColumn = null;
      view.sortDir = 'asc';
      view.filterColumn = '';
      view.filterValue = '';
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
      // Capture owner view + session so a background completion still lands on
      // the right table even if the user has navigated elsewhere.
      const view = this.activeTableView();
      const session = this.activeSession;
      if (!view?.database || !view?.table || !session) return;
      if (!reset && (view.loading || view.loadingMore || !view.hasMore)) return;

      const mod = window.MysqlClientTableGrid;
      view.connectionId = session.connection.id;
      const gkey = this.tableInflightKey(view, session);

      if (reset) {
        const prev = mod.inflight.get(gkey);
        if (prev) {
          try { prev.controller.abort(); } catch (_) { /* settled */ }
          mod.inflight.delete(gkey);
        }
        view.requestId += 1;
        view.offset = 0;
        view.rows = [];
        view.hasMore = false;
        view.loading = true;
        view.loadingMore = false;
        view.error = null;
        view.trimmed = false;
      } else {
        view.loadingMore = true;
      }
      const requestId = view.requestId;
      const inflightId = this.newRequestId();
      const controller = new AbortController();
      mod.inflight.set(gkey, {
        controller,
        requestId: inflightId,
        connectionId: view.connectionId,
      });

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
          requestId: inflightId,
        }, { signal: controller.signal });
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
        view.trimmed = false;
      } catch (err) {
        // Cancelled loads: canceller already cleared flags / bumped requestId.
        if (err.name === 'AbortError' || err.cancelled) return;
        if (requestId !== view.requestId) return;
        view.loadedLimit = null;
        view.error = err.message || 'Failed to load table';
        this.toast(view.error, 'error');
      } finally {
        const cur = mod.inflight.get(gkey);
        if (cur && cur.requestId === inflightId) mod.inflight.delete(gkey);
        if (requestId === view.requestId) {
          view.loading = false;
          view.loadingMore = false;
        }
        // Completed while inactive (user switched table/connection) — free rows.
        if (session.activeTableKey !== view.key || session !== this.activeSession) {
          this.trimInactiveTableView(view);
        }
      }
    },

    /** Abort the in-flight load for a table view (defaults to the active one). */
    async cancelTableLoad(view) {
      const session = this.activeSession;
      view = view || this.activeTableView();
      if (!view || !session) return;
      const mod = window.MysqlClientTableGrid;
      const gkey = this.tableInflightKey(view, session);
      const entry = mod.inflight.get(gkey);
      if (!entry) return;

      try { entry.controller.abort(); } catch (_) { /* settled */ }
      // Invalidate any late response and clear the busy flags immediately.
      view.requestId += 1;
      view.loading = false;
      view.loadingMore = false;
      mod.inflight.delete(gkey);
      try {
        await this.api('POST', '/api/query/cancel', {
          connectionId: entry.connectionId,
          requestId: entry.requestId,
        });
      } catch (_) { /* best-effort kill */ }
      this.toast('Load cancelled', 'info');
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
