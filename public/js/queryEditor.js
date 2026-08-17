/**
 * SQL query editor helpers for the Alpine root store (Chunk 6+).
 *
 * Script files persist as data/scripts/*.sql via /api/scripts. Saved
 * files reload whenever SQL mode is opened / page refreshes into SQL.
 *
 * Run executes only the statement under the cursor (semicolon-separated),
 * or the current selection if one exists.
 */
window.MysqlClientQueryEditor = {
  cm: null,
  loadedKey: null,
  syncing: false,
  nextLocalId: 1,
  // In-flight fetches keyed by tab id (and `${tabId}:more` for lazy pages).
  // Kept off the Alpine-reactive state so AbortController isn't proxied.
  inflight: new Map(),

  blankQueryTab(overrides = {}) {
    const id = overrides.id ?? `local-${this.nextLocalId++}`;
    return {
      id,
      fileId: null,
      title: 'Untitled',
      sql: '',
      savedSql: '',
      dirty: false,
      renaming: false,
      renameDraft: '',
      result: null,
      error: null,
      running: false,
      cancelling: false,
      durationMs: null,
      // Server-side lazy pages when the query has no manual LIMIT.
      resultBaseSql: null,
      resultLoadingMore: false,
      ...overrides,
    };
  },

  initialTabs() {
    return [this.blankQueryTab({ id: 'local-1', title: 'Untitled' })];
  },

  /**
   * Split SQL into statements on `;`, respecting quotes, backticks, and
   * `--` / `/* *\/` comments. Returns [{ sql, start, end }, ...] where
   * start/end are indexes into the original string (end exclusive of trailing `;`).
   */
  splitStatements(sql) {
    const text = String(sql || '');
    const statements = [];
    let start = 0;
    let i = 0;
    let inSingle = false;
    let inDouble = false;
    let inBacktick = false;
    let inLineComment = false;
    let inBlockComment = false;

    const pushStatement = (from, to) => {
      const chunk = text.slice(from, to);
      if (!chunk.trim()) return;
      // Trim trailing whitespace but keep leading indent for display.
      let end = chunk.length;
      while (end > 0 && /\s/.test(chunk[end - 1])) end -= 1;
      statements.push({
        sql: chunk.slice(0, end),
        start: from,
        end: from + end,
      });
    };

    while (i < text.length) {
      const ch = text[i];
      const next = text[i + 1];

      if (inLineComment) {
        if (ch === '\n') inLineComment = false;
        i += 1;
        continue;
      }
      if (inBlockComment) {
        if (ch === '*' && next === '/') {
          inBlockComment = false;
          i += 2;
          continue;
        }
        i += 1;
        continue;
      }
      if (inSingle) {
        if (ch === '\\' && next) {
          i += 2;
          continue;
        }
        if (ch === "'" && next === "'") {
          i += 2;
          continue;
        }
        if (ch === "'") inSingle = false;
        i += 1;
        continue;
      }
      if (inDouble) {
        if (ch === '\\' && next) {
          i += 2;
          continue;
        }
        if (ch === '"' && next === '"') {
          i += 2;
          continue;
        }
        if (ch === '"') inDouble = false;
        i += 1;
        continue;
      }
      if (inBacktick) {
        if (ch === '`' && next === '`') {
          i += 2;
          continue;
        }
        if (ch === '`') inBacktick = false;
        i += 1;
        continue;
      }

      if (ch === '-' && next === '-') {
        inLineComment = true;
        i += 2;
        continue;
      }
      if (ch === '/' && next === '*') {
        inBlockComment = true;
        i += 2;
        continue;
      }
      if (ch === "'") {
        inSingle = true;
        i += 1;
        continue;
      }
      if (ch === '"') {
        inDouble = true;
        i += 1;
        continue;
      }
      if (ch === '`') {
        inBacktick = true;
        i += 1;
        continue;
      }

      if (ch === ';') {
        pushStatement(start, i);
        start = i + 1;
        i += 1;
        continue;
      }
      i += 1;
    }

    pushStatement(start, text.length);
    return statements;
  },

  /**
   * Pick the statement to run: selection if present, otherwise the statement
   * containing the cursor (or the nearest non-empty statement before it).
   */
  statementAtCursor(sql, cursorIndex, selection) {
    const selected = String(selection || '').trim();
    if (selected) {
      return { sql: selected, fromSelection: true };
    }

    const statements = this.splitStatements(sql);
    if (statements.length === 0) return null;

    const idx = Math.max(0, Math.min(Number(cursorIndex) || 0, String(sql || '').length));
    let match = statements.find((s) => idx >= s.start && idx <= s.end);
    if (!match) {
      // Cursor sits on/after a semicolon or in whitespace between statements.
      match = [...statements].reverse().find((s) => s.end <= idx) || statements[0];
    }
    const trimmed = match.sql.trim();
    if (!trimmed) return null;
    return { sql: trimmed, fromSelection: false, start: match.start, end: match.end };
  },

  methods: {
    editorMode() {
      return this.activeSession?.viewMode || 'table';
    },

    async setEditorMode(mode) {
      const session = this.activeSession;
      if (!session) return;
      session.viewMode = mode;
      if (mode === 'sql') {
        await this.loadSavedScripts();
        // Apply cached schema (fetch only if this DB was never loaded).
        await this.ensureSqlCompletion?.();
        this.$nextTick(() => {
          this.mountSqlEditor();
          this.applySqlHintTables?.(
            window.MysqlClientSqlAutocomplete?.plainTables || {}
          );
        });
      }
    },

    /** Show Save as… for new tabs, Save when dirty; hide when already saved clean. */
    showSaveButton(tab = this.activeQueryTab()) {
      if (!tab) return false;
      if (tab.fileId == null) return true;
      return this.tabIsDirty(tab);
    },

    saveButtonLabel(tab = this.activeQueryTab()) {
      if (!tab) return 'Save as…';
      if (tab.fileId == null) return 'Save as…';
      return 'Save';
    },

    activeQueryTab() {
      const session = this.activeSession;
      if (!session) return null;
      return (session.queryTabs || []).find((t) => t.id === session.activeTabId) || null;
    },

    tabIsDirty(tab) {
      if (!tab) return false;
      if (tab.fileId == null) return Boolean((tab.sql || '').trim());
      return tab.sql !== tab.savedSql;
    },

    tabLabel(tab) {
      if (!tab) return '';
      const name = tab.title || 'Untitled';
      const marked = this.tabIsDirty(tab) ? `${name} •` : name;
      // Surface background-running queries on non-active tabs.
      return tab.running ? `${marked} ⏳` : marked;
    },

    /** Accent query tabs with the active connection theme_color. */
    queryTabStyle(tab) {
      const color = this.themeOf?.(this.activeSession?.connection) || '#3B82F6';
      const active = Boolean(tab && tab.id === this.activeSession?.activeTabId);
      if (active) {
        return [
          `border-bottom-color:${color}`,
          `background:color-mix(in srgb, ${color} 20%, transparent)`,
          `box-shadow:inset 0 -2px 0 ${color}`,
        ].join(';');
      }
      return [
        'border-bottom-color:transparent',
        `box-shadow:inset 3px 0 0 color-mix(in srgb, ${color} 50%, transparent)`,
      ].join(';');
    },

    queryTabRenameStyle() {
      const color = this.themeOf?.(this.activeSession?.connection) || '#3B82F6';
      return `border-color:${color}`;
    },

    /** Load saved script files from data/scripts and open them as tabs. */
    async loadSavedScripts() {
      const session = this.activeSession;
      if (!session) return;

      // Flush the current editor buffer into its tab before we rebuild the list.
      const mod = window.MysqlClientQueryEditor;
      if (mod.cm) {
        const current = this.activeQueryTab();
        if (current) current.sql = mod.cm.getValue();
      }

      try {
        const data = await this.api('GET', '/api/scripts');
        const scripts = data.scripts || [];
        const prevActive = session.activeTabId;
        const prevTabs = session.queryTabs || [];
        // Keep non-empty unsaved scratch tabs across a soft reload of the file list.
        const unsaved = prevTabs.filter(
          (t) => t.fileId == null && String(t.sql || '').trim().length > 0
        );

        const fileTabs = scripts.map((script) =>
          window.MysqlClientQueryEditor.blankQueryTab({
            id: `file-${script.id}`,
            fileId: script.id,
            title: script.name,
            sql: script.sql_text || '',
            savedSql: script.sql_text || '',
            dirty: false,
          })
        );

        // Preserve in-memory edits for files that were already open and dirty.
        for (const tab of fileTabs) {
          const prior = prevTabs.find((t) => t.fileId === tab.fileId);
          if (prior && prior.sql !== prior.savedSql) {
            tab.sql = prior.sql;
            tab.savedSql = prior.savedSql;
          }
          // Preserve result/error from the prior open of the same file.
          if (prior) {
            tab.result = prior.result;
            tab.error = prior.error;
            tab.durationMs = prior.durationMs;
            tab.resultBaseSql = prior.resultBaseSql || null;
            tab.resultLoadingMore = false;
          }
        }

        session.queryTabs = fileTabs.length
          ? fileTabs.concat(unsaved)
          : unsaved.length
            ? unsaved
            : [window.MysqlClientQueryEditor.blankQueryTab({ title: 'Untitled' })];

        const stillThere = session.queryTabs.find((t) => t.id === prevActive);
        session.activeTabId = stillThere
          ? prevActive
          : session.queryTabs[0].id;
      } catch (err) {
        this.toast(err.message || 'Failed to load scripts', 'error');
        if (!session.queryTabs?.length) {
          session.queryTabs = [window.MysqlClientQueryEditor.blankQueryTab({ title: 'Untitled' })];
          session.activeTabId = session.queryTabs[0].id;
        }
      }
    },

    mountSqlEditor() {
      const mod = window.MysqlClientQueryEditor;
      const host = document.getElementById('sql-editor-host');
      if (!host || !window.CodeMirror) return;

      if (!mod.cm) {
        mod.cm = window.CodeMirror(host, {
          value: '',
          mode: 'text/x-mysql',
          theme: this.isDarkTheme?.() === false ? 'default' : 'material-darker',
          lineNumbers: true,
          lineWrapping: true,
          autofocus: false,
          tabSize: 2,
          indentWithTabs: false,
          hintOptions: {
            tables: this.sqlCompletionTables || {},
            completeSingle: false,
          },
          extraKeys: {
            'Ctrl-Enter': () => this.executeSql(),
            'Cmd-Enter': () => this.executeSql(),
            'Ctrl-Space': (cm) => {
              this.triggerSqlAutocomplete?.(cm);
              return true;
            },
            'Cmd-Space': (cm) => {
              this.triggerSqlAutocomplete?.(cm);
              return true;
            },
            'Ctrl-S': () => {
              void this.saveActiveScript();
              return false;
            },
            'Cmd-S': () => {
              void this.saveActiveScript();
              return false;
            },
            'Ctrl-Shift-F': () => {
              this.formatActiveSql();
              return false;
            },
            'Cmd-Shift-F': () => {
              this.formatActiveSql();
              return false;
            },
          },
        });
        mod.cm.setSize('100%', '100%');
        mod.cm.on('change', () => {
          if (mod.syncing) return;
          const tab = this.activeQueryTab();
          if (!tab) return;
          tab.sql = mod.cm.getValue();
          tab.dirty = this.tabIsDirty(tab);
        });
        // Suggest while typing letters / dots (keywords, tables, columns).
        mod.cm.on('inputRead', (cm, change) => {
          if (change.origin !== '+input') return;
          const typed = change.text.join('');
          if (!typed || !/[A-Za-z0-9_.`$]/.test(typed)) return;
          if (cm.state.completionActive) return;
          this.triggerSqlAutocomplete?.(cm);
        });
      }

      this.syncEditorTheme?.();
      this.applySqlHintTables?.(this.sqlCompletionTables || {});
      // Re-apply saved editor font after CM mounts / remounts.
      this.applyAppSettings?.();
      this.syncEditorToActiveTab(true);
      this.$nextTick(() => {
        mod.cm.refresh();
        mod.cm.focus();
      });
    },

    editorSyncEffect() {
      const deps = `${this.activeConnectionId}:${this.activeSession?.activeTabId}`;
      if (deps && this.editorMode() !== 'sql') return;
      this.$nextTick(() => this.syncEditorToActiveTab());
    },

    syncEditorToActiveTab(force = false) {
      const mod = window.MysqlClientQueryEditor;
      if (!mod.cm) return;
      const session = this.activeSession;
      const tab = this.activeQueryTab();
      if (!session || !tab) return;
      const key = `${session.connection.id}:${tab.id}`;
      if (!force && key === mod.loadedKey) return;
      mod.syncing = true;
      mod.cm.setValue(tab.sql || '');
      mod.syncing = false;
      mod.loadedKey = key;
      mod.cm.refresh();
    },

    addQueryTab() {
      const session = this.activeSession;
      if (!session) return;
      const tab = window.MysqlClientQueryEditor.blankQueryTab({ title: 'Untitled' });
      session.queryTabs.push(tab);
      session.activeTabId = tab.id;
      this.$nextTick(() => this.syncEditorToActiveTab(true));
    },

    switchQueryTab(id) {
      const session = this.activeSession;
      if (!session || session.activeTabId === id) return;
      const mod = window.MysqlClientQueryEditor;
      if (mod.cm) {
        const current = this.activeQueryTab();
        if (current) {
          current.sql = mod.cm.getValue();
          current.dirty = this.tabIsDirty(current);
        }
      }
      session.activeTabId = id;
      this.$nextTick(() => this.syncEditorToActiveTab(true));
    },

    async closeQueryTab(id) {
      const session = this.activeSession;
      if (!session) return;
      const tabs = session.queryTabs || [];
      const idx = tabs.findIndex((t) => t.id === id);
      if (idx === -1) return;
      const tab = tabs[idx];

      if (tab.fileId != null) {
        const ok = window.confirm(
          `Delete saved script "${tab.title}"?\n\nThis removes it from disk and cannot be undone.`
        );
        if (!ok) return;
        try {
          await this.api(
            'DELETE',
            `/api/scripts/${encodeURIComponent(tab.fileId)}`
          );
        } catch (err) {
          this.toast(err.message || 'Failed to delete script', 'error');
          return;
        }
      } else if (this.tabIsDirty(tab)) {
        const ok = window.confirm('Discard unsaved changes in this tab?');
        if (!ok) return;
      }

      // Closing a tab releases any query it still has running.
      if (tab.running) void this.cancelSql(tab);

      tabs.splice(idx, 1);
      if (tabs.length === 0) {
        const blank = window.MysqlClientQueryEditor.blankQueryTab({ title: 'Untitled' });
        tabs.push(blank);
        session.activeTabId = blank.id;
      } else if (session.activeTabId === id) {
        session.activeTabId = tabs[Math.max(0, idx - 1)].id;
      }
      this.$nextTick(() => this.syncEditorToActiveTab(true));
    },

    startRenameTab(tab) {
      if (!tab) return;
      tab.renaming = true;
      tab.renameDraft = tab.title || '';
      this.$nextTick(() => {
        const input = document.querySelector(`[data-rename-tab="${tab.id}"]`);
        if (input) {
          input.focus();
          input.select();
        }
      });
    },

    cancelRenameTab(tab) {
      if (!tab) return;
      tab.renaming = false;
      tab.renameDraft = tab.title || '';
    },

    async commitRenameTab(tab) {
      if (!tab?.renaming) return;
      const next = String(tab.renameDraft || '').trim();
      tab.renaming = false;
      if (!next || next === tab.title) return;

      if (tab.fileId == null) {
        tab.title = next;
        return;
      }

      try {
        const oldTabId = tab.id;
        const data = await this.api(
          'PUT',
          `/api/scripts/${encodeURIComponent(tab.fileId)}`,
          { name: next }
        );
        tab.fileId = data.script.id;
        tab.id = `file-${data.script.id}`;
        tab.title = data.script.name;
        const session = this.activeSession;
        if (session?.activeTabId === oldTabId) {
          session.activeTabId = tab.id;
        }
        const mod = window.MysqlClientQueryEditor;
        if (mod.cm && session) {
          mod.loadedKey = `${session.connection.id}:${tab.id}`;
        }
        this.toast('Script renamed', 'success');
      } catch (err) {
        this.toast(err.message || 'Rename failed', 'error');
      }
    },

    async saveActiveScript() {
      const session = this.activeSession;
      const tab = this.activeQueryTab();
      if (!session || !tab) return;

      const mod = window.MysqlClientQueryEditor;
      if (mod.cm) tab.sql = mod.cm.getValue();

      try {
        if (tab.fileId == null) {
          let name = (tab.title || '').trim();
          if (!name || name === 'Untitled') {
            name = window.prompt('Save script as:', 'Script.sql');
            if (name == null) return;
            name = name.trim();
            if (!name) {
              this.toast('Name is required', 'error');
              return;
            }
          }
          const data = await this.api('POST', '/api/scripts', {
            name,
            sql: tab.sql || '',
          });
          tab.fileId = data.script.id;
          tab.id = `file-${data.script.id}`;
          tab.title = data.script.name;
          tab.savedSql = data.script.sql_text || '';
          tab.dirty = false;
          session.activeTabId = tab.id;
          this.toast('Script saved', 'success');
        } else {
          const data = await this.api(
            'PUT',
            `/api/scripts/${encodeURIComponent(tab.fileId)}`,
            { sql: tab.sql || '' }
          );
          tab.fileId = data.script.id;
          tab.savedSql = data.script.sql_text || '';
          tab.title = data.script.name;
          tab.dirty = false;
          this.toast('Script saved', 'success');
        }
        // Refresh CM key so sync doesn't think we switched tabs.
        if (mod.cm) {
          mod.loadedKey = `${session.connection.id}:${tab.id}`;
        }
      } catch (err) {
        this.toast(err.message || 'Save failed', 'error');
      }
    },

    queryResultRows() {
      const rows = this.activeQueryTab()?.result?.rows;
      return Array.isArray(rows) ? rows : [];
    },

    queryResultTotal() {
      return this.queryResultRows().length;
    },

    queryResultHasMore() {
      const tab = this.activeQueryTab();
      if (!tab?.result || tab.result.kind !== 'rows') return false;
      // Only auto-paginated queries (no manual LIMIT) keep loading.
      return Boolean(tab.result.paginated && tab.result.hasMore && tab.resultBaseSql);
    },

    resultPageSize() {
      const fromResult = Number(this.activeQueryTab()?.result?.limit);
      if (Number.isFinite(fromResult) && fromResult > 0) return fromResult;
      const configured = Number(this.activeSession?.connection?.row_limit);
      if (Number.isFinite(configured) && configured > 0) {
        return Math.min(1000, configured);
      }
      return 100;
    },

    async loadMoreQueryResultRows() {
      const session = this.activeSession;
      const tab = this.activeQueryTab();
      if (!session || !tab?.result || tab.result.kind !== 'rows') return;
      if (tab.resultLoadingMore || tab.running || !this.queryResultHasMore()) return;

      tab.resultLoadingMore = true;
      const mod = window.MysqlClientQueryEditor;
      const moreKey = `${tab.id}:more`;
      const requestId = this.newRequestId();
      const controller = new AbortController();
      mod.inflight.set(moreKey, { controller, requestId, connectionId: session.connection.id });
      try {
        const offset = Array.isArray(tab.result.rows) ? tab.result.rows.length : 0;
        const data = await this.api('POST', '/api/query/execute', {
          connectionId: session.connection.id,
          database: session.activeDatabase || null,
          sql: tab.resultBaseSql,
          offset,
          limit: this.resultPageSize(),
          requestId,
        }, { signal: controller.signal });
        if (data.kind !== 'rows') {
          tab.result.hasMore = false;
          return;
        }
        const nextRows = Array.isArray(data.rows) ? data.rows : [];
        tab.result.rows = (tab.result.rows || []).concat(nextRows);
        tab.result.rowCount = tab.result.rows.length;
        tab.result.hasMore = Boolean(data.paginated && data.hasMore);
        tab.result.paginated = Boolean(data.paginated);
        tab.result.offset = offset;
        tab.result.limit = data.limit || tab.result.limit;
        tab.result.sql = data.sql || tab.result.sql;
        tab.durationMs = data.durationMs ?? tab.durationMs;
      } catch (err) {
        if (err.name === 'AbortError' || err.cancelled) {
          tab.result.hasMore = false;
        } else {
          tab.result.hasMore = false;
          this.toast(err.message || 'Failed to load more rows', 'error');
        }
      } finally {
        const current = mod.inflight.get(moreKey);
        if (current && current.requestId === requestId) mod.inflight.delete(moreKey);
        tab.resultLoadingMore = false;
      }
    },

    onQueryResultScroll(event) {
      const el = event.currentTarget;
      if (!el || !this.queryResultHasMore()) return;
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 160) {
        void this.loadMoreQueryResultRows();
      }
    },

    formatActiveSql() {
      const session = this.activeSession;
      const tab = this.activeQueryTab();
      const mod = window.MysqlClientQueryEditor;
      if (!session || !tab) return;

      const formatter = window.sqlFormatter;
      if (!formatter?.format) {
        this.toast('SQL formatter not loaded', 'error');
        return;
      }

      if (mod.cm) tab.sql = mod.cm.getValue();
      const source = tab.sql || '';
      if (!source.trim()) {
        this.toast('Nothing to format', 'info');
        return;
      }

      try {
        const formatted = formatter.format(source, {
          language: 'mysql',
          tabWidth: 2,
          keywordCase: 'upper',
          linesBetweenQueries: 1,
        });
        tab.sql = formatted;
        tab.dirty = this.tabIsDirty(tab);
        if (mod.cm) {
          const cursor = mod.cm.getCursor();
          mod.syncing = true;
          mod.cm.setValue(formatted);
          mod.syncing = false;
          mod.cm.setCursor(cursor);
          mod.cm.focus();
        }
        this.toast('SQL formatted', 'success');
      } catch (err) {
        this.toast(err.message || 'Format failed', 'error');
      }
    },

    async executeSql() {
      const session = this.activeSession;
      const tab = this.activeQueryTab();
      if (!session || !tab || tab.running) return;

      const mod = window.MysqlClientQueryEditor;
      if (mod.cm) tab.sql = mod.cm.getValue();

      const fullSql = tab.sql || '';
      let cursorIndex = fullSql.length;
      let selection = '';
      if (mod.cm) {
        const sel = mod.cm.getSelection();
        selection = sel || '';
        cursorIndex = mod.cm.indexFromPos(mod.cm.getCursor());
      }

      const picked = window.MysqlClientQueryEditor.statementAtCursor(
        fullSql,
        cursorIndex,
        selection
      );
      if (!picked?.sql) {
        this.toast('Nothing to run', 'error');
        return;
      }

      tab.running = true;
      tab.cancelling = false;
      tab.error = null;
      tab.resultBaseSql = null;
      tab.resultLoadingMore = false;

      // Correlate the fetch with the server-side query so it can be killed.
      // Ownership: results always land on the captured `tab`, even if the user
      // switches tabs/sessions while the query runs.
      const requestId = this.newRequestId();
      const controller = new AbortController();
      mod.inflight.set(tab.id, { controller, requestId, connectionId: session.connection.id });

      try {
        const pageLimit =
          Number(session.connection?.row_limit) > 0
            ? Math.min(1000, Number(session.connection.row_limit))
            : 100;
        const data = await this.api('POST', '/api/query/execute', {
          connectionId: session.connection.id,
          database: session.activeDatabase || null,
          sql: picked.sql,
          offset: 0,
          limit: pageLimit,
          requestId,
        }, { signal: controller.signal });
        tab.result = data;
        tab.durationMs = data.durationMs ?? null;
        // Keep the original statement so scroll can request OFFSET pages.
        tab.resultBaseSql =
          data.kind === 'rows' && data.paginated ? picked.sql : null;
        if (data.kind === 'ok') {
          const affected = data.affectedRows ?? 0;
          this.toast(`OK · ${affected} row(s) affected`, 'success');
        }
      } catch (err) {
        if (err.name === 'AbortError' || err.cancelled) {
          // User cancelled — leave any prior result untouched, no red error.
          tab.error = null;
        } else {
          tab.error = err.message || 'Query failed';
          tab.result = null;
          tab.resultBaseSql = null;
          this.toast(tab.error, 'error');
        }
      } finally {
        const current = mod.inflight.get(tab.id);
        if (current && current.requestId === requestId) mod.inflight.delete(tab.id);
        tab.running = false;
        tab.cancelling = false;
      }
    },

    /** Abort every in-flight query for a connection (on disconnect). */
    abortSessionQueries(connectionId) {
      const mod = window.MysqlClientQueryEditor;
      const id = Number(connectionId);
      for (const [k, entry] of mod.inflight) {
        if (entry.connectionId === id) {
          try { entry.controller.abort(); } catch (_) { /* settled */ }
          mod.inflight.delete(k);
        }
      }
    },

    /** Abort a running query on `tab` (defaults to the active tab). */
    async cancelSql(tab) {
      tab = tab || this.activeQueryTab();
      if (!tab || !tab.running) return;
      const mod = window.MysqlClientQueryEditor;
      const main = mod.inflight.get(tab.id);
      const more = mod.inflight.get(`${tab.id}:more`);
      if (!main && !more) return;

      tab.cancelling = true;
      for (const entry of [main, more]) {
        if (!entry) continue;
        try { entry.controller.abort(); } catch (_) { /* already settled */ }
        try {
          await this.api('POST', '/api/query/cancel', {
            connectionId: entry.connectionId,
            requestId: entry.requestId,
          });
        } catch (_) { /* best-effort kill */ }
      }
      this.toast('Query cancelled', 'info');
    },
  },
};
