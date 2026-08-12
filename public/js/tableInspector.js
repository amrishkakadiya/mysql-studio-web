/**
 * Table inspector tabs: Columns & Keys, Indexes & Constraints, DDL (Chunk 7).
 */
window.MysqlClientTableInspector = {
  methods: {
    inspectorTab() {
      return this.activeTableView()?.inspectorTab || 'data';
    },

    async setInspectorTab(tab) {
      const view = this.activeTableView();
      if (!view?.database || !view?.table) return;
      const next = ['data', 'columns', 'indexes', 'ddl'].includes(tab) ? tab : 'data';
      view.inspectorTab = next;
      if (next !== 'data') {
        await this.ensureTableInspectorMeta();
      }
    },

    async ensureTableInspectorMeta({ force = false } = {}) {
      const view = this.activeTableView();
      const session = this.activeSession;
      if (!view?.database || !view?.table || !session) return null;
      if (!force && view.meta && !view.meta.loading && view.meta.columns) {
        return view.meta;
      }

      view.meta = {
        loading: true,
        columns: [],
        indexes: [],
        foreignKeys: [],
        createSql: '',
        error: null,
      };

      try {
        const data = await this.api(
          'GET',
          `/api/schema/${session.connection.id}/databases/${encodeURIComponent(view.database)}/tables/${encodeURIComponent(view.table)}`
        );
        view.meta = {
          loading: false,
          columns: data.columns || [],
          indexes: data.indexes || [],
          foreignKeys: data.foreignKeys || [],
          createSql: data.createSql || '',
          error: null,
        };

        // Keep schema-tree cache in sync if present.
        const tree = this.ensureTree?.(session.connection.id);
        if (tree) {
          const key = this.tableKey?.(view.database, view.table);
          if (key) {
            tree.tableMeta[key] = {
              loading: false,
              columns: view.meta.columns,
              indexes: view.meta.indexes,
              foreignKeys: view.meta.foreignKeys,
              createSql: view.meta.createSql,
            };
          }
        }
      } catch (err) {
        view.meta = {
          loading: false,
          columns: [],
          indexes: [],
          foreignKeys: [],
          createSql: '',
          error: err.message || 'Failed to load table metadata',
        };
        this.toast(view.meta.error, 'error');
      }
      return view.meta;
    },

    async copyInspectorDdl() {
      const sql = this.activeTableView()?.meta?.createSql || '';
      if (!sql) {
        this.toast('No DDL to copy', 'error');
        return;
      }
      try {
        await navigator.clipboard.writeText(sql);
        this.toast('DDL copied', 'success');
      } catch (_) {
        this.toast('Clipboard unavailable', 'error');
      }
    },

    keyBadge(key) {
      if (key === 'PRI') return 'PK';
      if (key === 'UNI') return 'UQ';
      if (key === 'MUL') return 'IDX';
      return key || '';
    },
  },
};
