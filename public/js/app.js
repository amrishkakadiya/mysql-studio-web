const STORAGE_OPEN = 'mysqlClient.openSessionIds';
const STORAGE_ACTIVE = 'mysqlClient.activeConnectionId';
const STORAGE_DBS = 'mysqlClient.activeDatabases';
const STORAGE_EXPLORER = 'mysqlClient.explorerCollapsed';

/** Schema explorer folders under each database (Chunk 4 deferred). */
const SCHEMA_FOLDERS = [
  { key: 'tables', label: 'Tables', kind: 'table', openMode: 'table' },
  { key: 'views', label: 'Views', kind: 'view', openMode: 'table' },
  { key: 'procedures', label: 'Procedures', kind: 'procedure', openMode: 'ddl' },
  { key: 'triggers', label: 'Triggers', kind: 'trigger', openMode: 'ddl' },
  { key: 'events', label: 'Events', kind: 'event', openMode: 'ddl' },
];

window.mysqlClient = function mysqlClient() {
  const tableGrid = window.MysqlClientTableGrid || { methods: {}, blankTableView: () => null };
  const clock = window.MysqlClientClock || { methods: {}, state: () => ({}) };
  const credits = window.MysqlStudioCredits || {
    methods: {},
    state: () => ({ creditsOpen: false }),
    info: { owner: 'Amrish Kakadiya', appName: 'MySQL Studio Web' },
  };
  const queryEditor = window.MysqlClientQueryEditor || { methods: {}, initialTabs: () => [] };
  const exportGrid = window.MysqlClientExportGrid || { methods: {} };
  const queryHistory = window.MysqlClientQueryHistory || {
    methods: {},
    state: () => ({ historyTimeUtc: true }),
  };
  const tableInspector = window.MysqlClientTableInspector || { methods: {} };
  const theme = window.MysqlClientTheme || { methods: {}, state: () => ({ uiTheme: 'dark' }) };
  const sqlAutocomplete = window.MysqlClientSqlAutocomplete || {
    methods: {},
    state: () => ({}),
  };
  const appSettings = window.MysqlClientAppSettings || {
    methods: {},
    state: () => ({}),
  };

  return {
    ...clock.state(),
    ...credits.state(),
    ...theme.state(),
    ...sqlAutocomplete.state(),
    ...appSettings.state(),
    ...queryHistory.state(),
    connections: [],
    sessions: {},
    schemaTrees: {},
    schemaFolderList: SCHEMA_FOLDERS,
    activeConnectionId: null,
    selectedConnectionId: null,
    connectionFilter: '',
    explorerCollapsed: false,
    loading: false,
    saving: false,
    testing: false,
    connectingId: null,
    modalOpen: false,
    deleteConfirmId: null,
    toasts: [],
    historyOpen: false,
    historyLoading: false,
    historyItems: [],
    exportOpen: false,
    exportRunning: false,
    exportError: null,
    exportResult: null,
    exportForm: window.MysqlClientExportGrid?.blankExportForm?.() || {
      source: 'table',
      scope: 'all',
      format: 'csv',
      fileMode: 'single',
      batchSize: 1000,
      baseName: '',
      relativePath: '',
    },
    exportMeta: { loadedCount: 0, canAll: true, exportRoot: '' },
    exportRecentFiles: [],
    exportFilesLoading: false,
    form: blankForm(),

    // Chunk 5: table data grid (public/js/tableGrid.js)
    ...tableGrid.methods,
    // Chunk 6: SQL query editor (public/js/queryEditor.js)
    ...queryEditor.methods,
    // Chunk 7 polish modules
    ...exportGrid.methods,
    ...queryHistory.methods,
    ...tableInspector.methods,
    ...sqlAutocomplete.methods,
    ...appSettings.methods,
    ...theme.methods,
    ...clock.methods,
    ...credits.methods,

    get openSessions() {
      return Object.values(this.sessions);
    },

    get activeSession() {
      if (this.activeConnectionId == null) return null;
      return this.sessions[this.activeConnectionId] || null;
    },

    get selectedConnection() {
      if (this.selectedConnectionId == null) return null;
      return (
        this.connections.find((c) => c.id === Number(this.selectedConnectionId)) || null
      );
    },

    get filteredConnections() {
      const q = (this.connectionFilter || '').trim().toLowerCase();
      if (!q) return this.connections;
      return this.connections.filter((conn) => {
        const hay = [conn.nickname, conn.host, conn.user, conn.database_name]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return hay.includes(q);
      });
    },

    isOpen(connectionId) {
      return Boolean(this.sessions[connectionId]);
    },

    themeOf(connection) {
      return connection?.theme_color || '#3B82F6';
    },

    headerBadgeStyle(connection) {
      const color = this.themeOf(connection);
      if (this.activeConnectionId === connection.id) {
        return [
          `border-color: ${color}`,
          `border-left: 3px solid ${color}`,
          `box-shadow: 0 0 0 1px ${color}, 0 0 12px ${color}88, 0 0 22px ${color}44`,
        ].join('; ');
      }
      return `border-left: 3px solid ${color}`;
    },

    connectionRowStyle(connection) {
      const color = this.themeOf(connection);
      const parts = [];
      if (this.isOpen(connection.id)) {
        parts.push(
          `background: color-mix(in srgb, ${color} 12%, transparent)`,
          `box-shadow: inset 3px 0 0 ${color}`
        );
      }
      if (this.selectedConnectionId === connection.id) {
        parts.push(
          `background: color-mix(in srgb, ${color} 22%, transparent)`,
          `box-shadow: inset 3px 0 0 ${color}, 0 0 0 1px ${color}55`
        );
      }
      return parts.join('; ');
    },

    tree(connectionId) {
      return this.schemaTrees[connectionId] || null;
    },

    ensureTree(connectionId) {
      const id = Number(connectionId);
      if (!this.schemaTrees[id]) {
        this.schemaTrees[id] = {
          search: '',
          databases: null,
          databasesLoading: false,
          databasesFailed: false,
          expandedDbs: {},
          expandedFolders: {},
          dbChildren: {},
          expandedTables: {},
          tableMeta: {},
          selectedObject: null,
        };
      } else if (!this.schemaTrees[id].expandedFolders) {
        this.schemaTrees[id].expandedFolders = {};
      }
      return this.schemaTrees[id];
    },

    folderKey(databaseName, folderKey) {
      return `${databaseName}::${folderKey}`;
    },

    schemaQuery(connectionId) {
      return (this.tree(connectionId)?.search || '').trim().toLowerCase();
    },

    nameMatches(connectionId, label) {
      const q = this.schemaQuery(connectionId);
      if (!q) return true;
      return String(label || '').toLowerCase().includes(q);
    },

    folderItems(connectionId, databaseName, folderKey) {
      const child = this.tree(connectionId)?.dbChildren[databaseName];
      if (!child) return [];
      const list = child[folderKey];
      return Array.isArray(list) ? list : [];
    },

    visibleFolderItems(connectionId, databaseName, folderKey) {
      return this.folderItems(connectionId, databaseName, folderKey).filter((name) =>
        this.nameMatches(connectionId, name)
      );
    },

    visibleTables(connectionId, databaseName) {
      return this.visibleFolderItems(connectionId, databaseName, 'tables');
    },

    visibleViews(connectionId, databaseName) {
      return this.visibleFolderItems(connectionId, databaseName, 'views');
    },

    dbHasSearchMatches(connectionId, databaseName) {
      return SCHEMA_FOLDERS.some(
        (folder) => this.visibleFolderItems(connectionId, databaseName, folder.key).length > 0
      );
    },

    visibleDatabases(connectionId) {
      const tree = this.tree(connectionId);
      if (!tree || !tree.databases) return [];
      const q = this.schemaQuery(connectionId);
      if (!q) return tree.databases;
      return tree.databases.filter((db) => {
        if (this.nameMatches(connectionId, db)) return true;
        return this.dbHasSearchMatches(connectionId, db);
      });
    },

    isDbExpanded(connectionId, databaseName) {
      const tree = this.tree(connectionId);
      if (!tree) return false;
      if (this.schemaQuery(connectionId) && this.dbHasSearchMatches(connectionId, databaseName)) {
        return true;
      }
      return Boolean(tree.expandedDbs[databaseName]);
    },

    isSchemaFolderExpanded(connectionId, databaseName, folderKey) {
      const tree = this.tree(connectionId);
      if (!tree) return false;
      const key = this.folderKey(databaseName, folderKey);
      if (this.schemaQuery(connectionId)) {
        if (this.visibleFolderItems(connectionId, databaseName, folderKey).length > 0) {
          return true;
        }
      }
      if (tree.expandedFolders[key] != null) {
        return Boolean(tree.expandedFolders[key]);
      }
      // Default: Tables open so the common path stays one click.
      return folderKey === 'tables';
    },

    toggleSchemaFolder(connectionId, databaseName, folderKey) {
      const tree = this.ensureTree(connectionId);
      const key = this.folderKey(databaseName, folderKey);
      tree.expandedFolders[key] = !this.isSchemaFolderExpanded(
        connectionId,
        databaseName,
        folderKey
      );
    },

    isSchemaObjectSelected(connectionId, databaseName, kind, name) {
      const sel = this.tree(connectionId)?.selectedObject;
      return (
        sel &&
        sel.database === databaseName &&
        sel.kind === kind &&
        sel.name === name
      );
    },

    async init() {
      this.initTheme?.();
      this.initClock?.();
      this.explorerCollapsed = localStorage.getItem(STORAGE_EXPLORER) === '1';
      await this.loadAppSettings?.();
      await this.loadConnections();
      await this.restoreSessions();
    },

    toggleExplorer() {
      this.explorerCollapsed = !this.explorerCollapsed;
      localStorage.setItem(STORAGE_EXPLORER, this.explorerCollapsed ? '1' : '0');
    },

    async api(method, url, body) {
      const options = {
        method,
        headers: { Accept: 'application/json' },
      };
      if (body !== undefined) {
        options.headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(body);
      }
      const res = await fetch(url, options);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || data.message || `Request failed (${res.status})`);
      }
      return data;
    },

    toast(message, type = 'info', options = {}) {
      const id = Date.now() + Math.random();
      const entry = {
        id,
        message: String(message || ''),
        type: ['success', 'error', 'info', 'warning'].includes(type) ? type : 'info',
        title: options.title || null,
      };
      this.toasts = [...this.toasts, entry].slice(-5);
      const duration =
        options.duration ??
        (entry.type === 'error' ? 6500 : entry.type === 'warning' ? 5000 : 3500);
      if (duration > 0) {
        setTimeout(() => this.dismissToast(id), duration);
      }
      return id;
    },

    dismissToast(id) {
      this.toasts = this.toasts.filter((t) => t.id !== id);
    },

    toastIcon(type) {
      if (type === 'success') return '✓';
      if (type === 'error') return '!';
      if (type === 'warning') return '⚠';
      return 'i';
    },

    persistSessions() {
      const ids = Object.keys(this.sessions).map(Number);
      localStorage.setItem(STORAGE_OPEN, JSON.stringify(ids));
      if (this.activeConnectionId != null) {
        localStorage.setItem(STORAGE_ACTIVE, String(this.activeConnectionId));
      } else {
        localStorage.removeItem(STORAGE_ACTIVE);
      }

      const dbs = {};
      for (const [id, session] of Object.entries(this.sessions)) {
        if (session.activeDatabase) dbs[id] = session.activeDatabase;
      }
      localStorage.setItem(STORAGE_DBS, JSON.stringify(dbs));
    },

    createSession(connection) {
      let savedDbs = {};
      try {
        savedDbs = JSON.parse(localStorage.getItem(STORAGE_DBS) || '{}');
      } catch (_) {
        savedDbs = {};
      }
      const blankView =
        (window.MysqlClientTableGrid && window.MysqlClientTableGrid.blankTableView) ||
        (() => null);
      const editor =
        window.MysqlClientQueryEditor || {
          initialTabs: () => [{ id: 'local-1', title: 'Untitled', sql: '', fileId: null }],
        };
      const tabs = editor.initialTabs();
      return {
        connection,
        activeDatabase:
          savedDbs[connection.id] || connection.database_name || null,
        viewMode: 'table',
        queryTabs: tabs,
        activeTabId: tabs[0]?.id || 'local-1',
        tableView: blankView(),
      };
    },

    switchSession(connectionId) {
      if (!this.sessions[connectionId]) return;
      this.activeConnectionId = Number(connectionId);
      this.persistSessions();
      const session = this.sessions[connectionId];
      if (session?.viewMode === 'sql' && session.activeDatabase) {
        // Memory cache only — no API call on session/tab switch.
        if (
          !this.applyCachedCompletion?.(session.connection.id, session.activeDatabase)
        ) {
          void this.ensureSqlCompletion?.();
        }
      }
    },

    selectConnection(connectionId) {
      const id = Number(connectionId);
      this.selectedConnectionId = id;
      if (this.isOpen(id)) {
        this.switchSession(id);
        this.explorerCollapsed = false;
      }
    },

    selectDatabase(connectionId, databaseName) {
      const session = this.sessions[connectionId];
      if (!session) return;
      session.activeDatabase = databaseName;
      this.activeConnectionId = Number(connectionId);
      this.persistSessions();
      // Prefetch schema into memory when a DB is selected (once per DB).
      void this.prefetchSqlCompletion?.(connectionId, databaseName);
      if (session.viewMode === 'sql') {
        void this.ensureSqlCompletion?.();
      }
    },

    async restoreSessions() {
      let openIds = [];
      try {
        openIds = JSON.parse(localStorage.getItem(STORAGE_OPEN) || '[]');
      } catch (_) {
        openIds = [];
      }
      if (!Array.isArray(openIds) || openIds.length === 0) return;

      const savedActive = Number(localStorage.getItem(STORAGE_ACTIVE));
      for (const id of openIds) {
        const exists = this.connections.some((c) => c.id === Number(id));
        if (!exists) continue;
        try {
          await this.connectSession(Number(id), { silent: true, activate: false });
        } catch (_) {
          // skip profiles that fail to reconnect
        }
      }

      if (this.sessions[savedActive]) {
        this.activeConnectionId = savedActive;
      } else {
        const first = Object.keys(this.sessions)[0];
        this.activeConnectionId = first ? Number(first) : null;
      }
      this.persistSessions();

      if (this.activeConnectionId != null) {
        this.selectedConnectionId = this.activeConnectionId;
      }
    },

    async loadConnections() {
      this.loading = true;
      try {
        const data = await this.api('GET', '/api/connections');
        this.connections = data.connections || [];
        for (const id of Object.keys(this.sessions)) {
          const updated = this.connections.find((c) => c.id === Number(id));
          if (updated) {
            this.sessions[id].connection = updated;
          }
        }
      } catch (err) {
        this.toast(err.message, 'error');
      } finally {
        this.loading = false;
      }
    },

    async connectSession(connectionId, { silent = false, activate = true } = {}) {
      const id = Number(connectionId);
      this.connectingId = id;
      try {
        const data = await this.api('POST', `/api/connections/${id}/connect`);
        const connection = data.connection;
        if (!this.sessions[id]) {
          this.sessions[id] = this.createSession(connection);
        } else {
          this.sessions[id].connection = connection;
        }
        this.ensureTree(id);
        if (activate) {
          this.activeConnectionId = id;
          this.selectedConnectionId = id;
          this.explorerCollapsed = false;
        }
        this.persistSessions();
        if (!silent) {
          this.toast(`Connected to ${connection.nickname}`, 'success');
        }
      } catch (err) {
        if (!silent) this.toast(err.message, 'error');
        throw err;
      } finally {
        this.connectingId = null;
      }
    },

    async disconnectSession(connectionId) {
      const id = Number(connectionId);
      try {
        await this.api('POST', `/api/connections/${id}/disconnect`);
      } catch (err) {
        this.toast(err.message, 'error');
        return;
      }

      const nickname = this.sessions[id]?.connection?.nickname || `Connection ${id}`;
      delete this.sessions[id];
      delete this.schemaTrees[id];

      if (this.activeConnectionId === id) {
        const remaining = Object.keys(this.sessions);
        this.activeConnectionId = remaining.length ? Number(remaining[0]) : null;
        if (this.activeConnectionId != null) {
          this.selectedConnectionId = this.activeConnectionId;
        }
      }
      this.persistSessions();
      this.toast(`Disconnected ${nickname}`, 'info');
    },

    ensureDatabases(connectionId) {
      const id = Number(connectionId);
      if (!this.isOpen(id)) return;
      const tree = this.ensureTree(id);
      // databasesFailed keeps a broken connection from retrying on every re-render.
      if (tree.databases == null && !tree.databasesLoading && !tree.databasesFailed) {
        void this.loadDatabases(id);
      }
    },

    async loadDatabases(connectionId) {
      const id = Number(connectionId);
      const tree = this.ensureTree(id);
      if (tree.databasesLoading) return;
      tree.databasesLoading = true;
      tree.databasesFailed = false;
      try {
        const data = await this.api('GET', `/api/schema/${id}/databases`);
        tree.databases = data.databases || [];
        tree.databasesFailed = false;
      } catch (err) {
        if (tree.databases == null) {
          tree.databasesFailed = true;
        }
        this.toast(err.message, 'error');
      } finally {
        tree.databasesLoading = false;
      }
    },

    async toggleDatabase(connectionId, databaseName) {
      const id = Number(connectionId);
      const tree = this.ensureTree(id);
      this.selectDatabase(id, databaseName);
      const open = !tree.expandedDbs[databaseName];
      tree.expandedDbs[databaseName] = open;
      if (open && !tree.dbChildren[databaseName]) {
        await this.loadTables(id, databaseName);
      }
    },

    async loadTables(connectionId, databaseName) {
      const id = Number(connectionId);
      const tree = this.ensureTree(id);
      tree.dbChildren[databaseName] = {
        loading: true,
        tables: [],
        views: [],
        procedures: [],
        triggers: [],
        events: [],
      };
      try {
        const data = await this.api(
          'GET',
          `/api/schema/${id}/databases/${encodeURIComponent(databaseName)}/tables`
        );
        tree.dbChildren[databaseName] = {
          loading: false,
          tables: data.tables || [],
          views: data.views || [],
          procedures: data.procedures || [],
          triggers: data.triggers || [],
          events: data.events || [],
        };
      } catch (err) {
        delete tree.dbChildren[databaseName];
        tree.expandedDbs[databaseName] = false;
        this.toast(err.message, 'error');
      }
    },

    /**
     * Open procedure / trigger / event CREATE SQL in a new SQL editor tab.
     */
    async openSchemaObject(connectionId, databaseName, kind, objectName) {
      const id = Number(connectionId);
      if (!['procedure', 'trigger', 'event'].includes(kind)) return;

      this.selectDatabase(id, databaseName);
      const tree = this.ensureTree(id);
      tree.selectedObject = { database: databaseName, kind, name: objectName };

      try {
        const data = await this.api(
          'GET',
          `/api/schema/${id}/databases/${encodeURIComponent(databaseName)}/${encodeURIComponent(kind)}/${encodeURIComponent(objectName)}`
        );
        const sql = String(data.createSql || '').trim();
        if (!sql) {
          this.toast(`No CREATE SQL for ${kind} ${objectName}`, 'error');
          return;
        }

        await this.setEditorMode?.('sql');
        await this.$nextTick?.();

        this.addQueryTab?.();
        const tab = this.activeQueryTab?.();
        if (!tab) return;

        const label =
          kind === 'procedure' ? 'Procedure' : kind === 'trigger' ? 'Trigger' : 'Event';
        tab.title = `${label}: ${objectName}`;
        tab.sql = sql;
        tab.savedSql = '';
        tab.dirty = true;
        tab.error = null;
        tab.result = null;

        const mod = window.MysqlClientQueryEditor;
        if (mod?.cm) {
          mod.syncing = true;
          mod.cm.setValue(sql);
          mod.syncing = false;
          mod.cm.focus();
        }
      } catch (err) {
        this.toast(err.message || `Failed to open ${kind}`, 'error');
      }
    },

    tableKey(databaseName, tableName) {
      return `${databaseName}.${tableName}`;
    },

    async toggleTableMeta(connectionId, databaseName, tableName) {
      const id = Number(connectionId);
      this.selectDatabase(id, databaseName);
      const tree = this.ensureTree(id);
      const key = this.tableKey(databaseName, tableName);
      const open = !tree.expandedTables[key];
      tree.expandedTables[key] = open;
      if (open && !tree.tableMeta[key]) {
        await this.loadTableMeta(id, databaseName, tableName);
      }
    },

    async loadTableMeta(connectionId, databaseName, tableName) {
      const id = Number(connectionId);
      const tree = this.ensureTree(id);
      const key = this.tableKey(databaseName, tableName);
      tree.tableMeta[key] = {
        loading: true,
        columns: [],
        indexes: [],
        foreignKeys: [],
        createSql: '',
      };
      try {
        const data = await this.api(
          'GET',
          `/api/schema/${id}/databases/${encodeURIComponent(databaseName)}/tables/${encodeURIComponent(tableName)}`
        );
        tree.tableMeta[key] = {
          loading: false,
          columns: data.columns || [],
          indexes: data.indexes || [],
          foreignKeys: data.foreignKeys || [],
          createSql: data.createSql || '',
        };
      } catch (err) {
        delete tree.tableMeta[key];
        tree.expandedTables[key] = false;
        this.toast(err.message, 'error');
      }
    },

    openCreate() {
      this.form = blankForm();
      this.modalOpen = true;
    },

    openEdit(conn) {
      this.form = {
        id: conn.id,
        nickname: conn.nickname,
        host: conn.host,
        port: conn.port,
        user: conn.user,
        password: '',
        database_name: conn.database_name || '',
        theme_color: conn.theme_color || '#3B82F6',
        keep_alive: Boolean(conn.keep_alive),
        keep_alive_interval_sec: conn.keep_alive_interval_sec || 120,
        row_limit: conn.row_limit || 100,
      };
      this.modalOpen = true;
    },

    closeModal() {
      this.modalOpen = false;
      this.form = blankForm();
    },

    formPayload() {
      return {
        nickname: this.form.nickname,
        host: this.form.host,
        port: Number(this.form.port) || 3306,
        user: this.form.user,
        password: this.form.password,
        database_name: this.form.database_name || null,
        theme_color: this.form.theme_color || '#3B82F6',
        keep_alive: Boolean(this.form.keep_alive),
        keep_alive_interval_sec: Number(this.form.keep_alive_interval_sec) || 120,
        row_limit: Number(this.form.row_limit) || 100,
      };
    },

    async saveConnection() {
      this.saving = true;
      try {
        const payload = this.formPayload();
        if (this.form.id) {
          await this.api('PUT', `/api/connections/${this.form.id}`, payload);
          this.toast('Connection updated', 'success');
        } else {
          await this.api('POST', '/api/connections', payload);
          this.toast('Connection saved', 'success');
        }
        this.closeModal();
        await this.loadConnections();
      } catch (err) {
        this.toast(err.message, 'error');
      } finally {
        this.saving = false;
      }
    },

    async testConnectivity() {
      this.testing = true;
      try {
        const payload = this.formPayload();
        if (this.form.id) payload.id = this.form.id;
        const result = await this.api('POST', '/api/connections/test', payload);
        if (result.ok) {
          this.toast(result.message || 'Connection successful', 'success');
        } else {
          this.toast(result.message || 'Connection failed', 'error');
        }
      } catch (err) {
        this.toast(err.message, 'error');
      } finally {
        this.testing = false;
      }
    },

    async testSaved(conn) {
      try {
        const result = await this.api('POST', '/api/connections/test', { id: conn.id });
        if (result.ok) {
          this.toast(`${conn.nickname}: ${result.message || 'OK'}`, 'success');
        } else {
          this.toast(`${conn.nickname}: ${result.message || 'Failed'}`, 'error');
        }
      } catch (err) {
        this.toast(`${conn.nickname}: ${err.message}`, 'error');
      }
    },

    askDelete(conn) {
      this.deleteConfirmId = conn.id;
    },

    async confirmDelete() {
      const id = this.deleteConfirmId;
      if (!id) return;
      try {
        if (this.isOpen(id)) {
          try {
            await this.api('POST', `/api/connections/${id}/disconnect`);
          } catch (_) {
            // pool may already be closed
          }
          delete this.sessions[id];
          delete this.schemaTrees[id];
          if (this.activeConnectionId === id) {
            const remaining = Object.keys(this.sessions);
            this.activeConnectionId = remaining.length ? Number(remaining[0]) : null;
          }
          this.persistSessions();
        }
        await this.api('DELETE', `/api/connections/${id}`);
        this.toast('Connection deleted', 'success');
        this.deleteConfirmId = null;
        if (this.selectedConnectionId === id) {
          this.selectedConnectionId = this.activeConnectionId;
        }
        await this.loadConnections();
      } catch (err) {
        this.toast(err.message, 'error');
      }
    },
  };
};

function blankForm() {
  return {
    id: null,
    nickname: '',
    host: '127.0.0.1',
    port: 3306,
    user: 'root',
    password: '',
    database_name: '',
    theme_color: '#3B82F6',
    keep_alive: false,
    keep_alive_interval_sec: 120,
    row_limit: 100,
  };
}
