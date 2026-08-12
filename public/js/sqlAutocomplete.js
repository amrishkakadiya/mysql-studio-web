/**
 * SQL autocomplete helpers — feeds CodeMirror sql-hint from schema API.
 * Completion schemas are cached in memory per connection+database.
 */
window.MysqlClientSqlAutocomplete = {
  DEFAULT_SPLIT_PCT: 40,
  MIN_SPLIT_PCT: 15,
  MAX_SPLIT_PCT: 80,
  // Plain (non-Proxy) copy for the active DB — sql-hint breaks on Alpine proxies.
  plainTables: {},
  // In-memory cache: "connectionId:database" → plain tables map
  completionCache: Object.create(null),
  inflight: Object.create(null),

  state() {
    return {
      // Split height is in-memory only (not persisted).
      sqlEditorSplitPct: this.DEFAULT_SPLIT_PCT,
      sqlSplitDragging: false,
      sqlCompletionKey: null,
      sqlCompletionTables: {},
      sqlCompletionLoading: false,
      sqlCompletionCount: 0,
    };
  },

  toPlainTables(tables) {
    const plain = {};
    if (!tables || typeof tables !== 'object') return plain;
    for (const key of Object.keys(tables)) {
      const cols = tables[key];
      plain[key] = Array.isArray(cols) ? cols.map((c) => String(c)) : [];
    }
    return plain;
  },

  cacheKey(connectionId, database) {
    return `${Number(connectionId)}:${database}`;
  },

  methods: {
    applySqlHintTables(tables) {
      const plain = window.MysqlClientSqlAutocomplete.toPlainTables(tables);
      window.MysqlClientSqlAutocomplete.plainTables = plain;
      this.sqlCompletionTables = plain;
      this.sqlCompletionCount = Object.keys(plain).length;

      const mod = window.MysqlClientQueryEditor;
      if (mod?.cm) {
        mod.cm.setOption('hintOptions', {
          tables: plain,
          completeSingle: false,
          disableKeywords: false,
        });
      }
    },

    applyCachedCompletion(connectionId, database) {
      if (!database) {
        this.sqlCompletionKey = null;
        this.applySqlHintTables({});
        return false;
      }
      const key = window.MysqlClientSqlAutocomplete.cacheKey(connectionId, database);
      const cached = window.MysqlClientSqlAutocomplete.completionCache[key];
      if (!cached) return false;
      this.sqlCompletionKey = key;
      this.applySqlHintTables(cached);
      return true;
    },

    /**
     * Fetch + cache completion for a database. Safe to call when selecting a DB
     * (even outside SQL mode). Skips network when already cached unless force.
     */
    async prefetchSqlCompletion(connectionId, database, { force = false } = {}) {
      const id = Number(connectionId);
      if (!id || !database) return null;

      const key = window.MysqlClientSqlAutocomplete.cacheKey(id, database);
      const cache = window.MysqlClientSqlAutocomplete.completionCache;
      if (!force && cache[key]) return cache[key];
      if (window.MysqlClientSqlAutocomplete.inflight[key]) {
        return window.MysqlClientSqlAutocomplete.inflight[key];
      }

      const run = (async () => {
        try {
          const data = await this.api(
            'GET',
            `/api/schema/${id}/databases/${encodeURIComponent(database)}/completion`
          );
          const plain = window.MysqlClientSqlAutocomplete.toPlainTables(
            data.tables || {}
          );
          cache[key] = plain;
          return plain;
        } finally {
          delete window.MysqlClientSqlAutocomplete.inflight[key];
        }
      })();

      window.MysqlClientSqlAutocomplete.inflight[key] = run;
      return run;
    },

    /**
     * Ensure the active session DB schema is applied for the editor.
     * Uses memory cache; fetches once per DB when missing.
     */
    async ensureSqlCompletion({ force = false } = {}) {
      const session = this.activeSession;
      if (!session) return;

      const database = session.activeDatabase || null;
      if (!database) {
        this.sqlCompletionKey = null;
        this.applySqlHintTables({});
        return;
      }

      const key = window.MysqlClientSqlAutocomplete.cacheKey(
        session.connection.id,
        database
      );

      if (!force && this.applyCachedCompletion(session.connection.id, database)) {
        return;
      }

      this.sqlCompletionLoading = true;
      try {
        // Seed from explorer while waiting (table names only if meta missing).
        const explorerTables = this.tablesFromExplorer?.(
          session.connection.id,
          database
        );
        if (explorerTables && Object.keys(explorerTables).length) {
          this.applySqlHintTables(explorerTables);
        }

        const plain = await this.prefetchSqlCompletion(
          session.connection.id,
          database,
          { force }
        );
        if (plain) {
          this.sqlCompletionKey = key;
          this.applySqlHintTables(plain);
        }
      } catch (err) {
        console.warn('SQL completion schema failed:', err.message || err);
      } finally {
        this.sqlCompletionLoading = false;
      }
    },

    // Back-compat alias used by older call sites.
    async refreshSqlCompletion(opts) {
      return this.ensureSqlCompletion(opts);
    },

    tablesFromExplorer(connectionId, database) {
      const tree = this.tree?.(connectionId);
      if (!tree || !database) return {};
      const child = tree.dbChildren?.[database];
      const names = [...(child?.tables || []), ...(child?.views || [])];
      const tables = {};
      for (const name of names) {
        const meta = tree.tableMeta?.[`${database}.${name}`];
        tables[name] = (meta?.columns || []).map((c) => c.name || c).filter(Boolean);
      }
      return tables;
    },

    triggerSqlAutocomplete(cm) {
      const editor = cm || window.MysqlClientQueryEditor?.cm;
      const CM = window.CodeMirror;
      if (!editor || !CM?.showHint || !CM.hint?.sql) return;

      const tables =
        window.MysqlClientSqlAutocomplete.plainTables ||
        window.MysqlClientSqlAutocomplete.toPlainTables(this.sqlCompletionTables);

      editor.setOption('hintOptions', {
        tables,
        completeSingle: false,
        disableKeywords: false,
      });

      CM.showHint(editor, CM.hint.sql, {
        completeSingle: false,
        tables,
      });
    },

    openSqlHints() {
      void this.ensureSqlCompletion?.().then(() => {
        this.$nextTick?.(() => this.triggerSqlAutocomplete());
      });
    },

    sqlEditorPaneStyle() {
      const pct = Number(this.sqlEditorSplitPct);
      const clamped = Number.isFinite(pct)
        ? Math.min(
            window.MysqlClientSqlAutocomplete.MAX_SPLIT_PCT,
            Math.max(window.MysqlClientSqlAutocomplete.MIN_SPLIT_PCT, pct)
          )
        : window.MysqlClientSqlAutocomplete.DEFAULT_SPLIT_PCT;
      return `flex: 0 0 ${clamped}%; height: ${clamped}%; max-height: ${clamped}%;`;
    },

    startSqlSplitResize(event) {
      event.preventDefault();
      const body = document.getElementById('sql-split-body');
      if (!body) return;

      const startY = event.clientY;
      const startPct =
        Number(this.sqlEditorSplitPct) ||
        window.MysqlClientSqlAutocomplete.DEFAULT_SPLIT_PCT;
      const height = body.getBoundingClientRect().height || 1;
      this.sqlSplitDragging = true;
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';

      const onMove = (ev) => {
        const deltaPct = ((ev.clientY - startY) / height) * 100;
        const next = startPct + deltaPct;
        this.sqlEditorSplitPct = Math.min(
          window.MysqlClientSqlAutocomplete.MAX_SPLIT_PCT,
          Math.max(window.MysqlClientSqlAutocomplete.MIN_SPLIT_PCT, next)
        );
        const mod = window.MysqlClientQueryEditor;
        if (mod?.cm) mod.cm.refresh();
      };

      const onUp = () => {
        this.sqlSplitDragging = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        const mod = window.MysqlClientQueryEditor;
        if (mod?.cm) mod.cm.refresh();
      };

      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
  },
};
