/**
 * CSV / JSON export — quick browser download + richer batched export to data/exports/.
 */
window.MysqlClientExportGrid = {
  csvCell(value) {
    if (value === null || value === undefined) return '';
    let text;
    if (typeof value === 'object') {
      try {
        text = JSON.stringify(value);
      } catch (_) {
        text = String(value);
      }
    } else {
      text = String(value);
    }
    if (/[",\r\n]/.test(text)) {
      return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
  },

  toCsv(columns, rows) {
    const cols = Array.isArray(columns) ? columns : [];
    const data = Array.isArray(rows) ? rows : [];
    const lines = [cols.map((c) => this.csvCell(c)).join(',')];
    for (const row of data) {
      lines.push(cols.map((col) => this.csvCell(row?.[col])).join(','));
    }
    return `${lines.join('\r\n')}\r\n`;
  },

  toJson(columns, rows) {
    const cols = Array.isArray(columns) ? columns : [];
    const data = Array.isArray(rows) ? rows : [];
    const objects = data.map((row) => {
      const obj = {};
      for (const col of cols) obj[col] = row?.[col] ?? null;
      return obj;
    });
    return `${JSON.stringify(objects, null, 2)}\n`;
  },

  downloadText(filename, content, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  },

  safeFilename(base, ext) {
    const stem = String(base || 'export')
      .replace(/[<>:"/\\|?*\0-\x1f]+/g, '_')
      .replace(/\s+/g, '_')
      .slice(0, 80) || 'export';
    return `${stem}.${ext}`;
  },

  formatBytes(n) {
    const bytes = Number(n) || 0;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  },

  blankExportForm(overrides = {}) {
    return {
      source: 'table',
      scope: 'all',
      format: 'csv',
      fileMode: 'single',
      batchSize: 1000,
      baseName: '',
      relativePath: '',
      ...overrides,
    };
  },

  methods: {
    exportGridPayload(source) {
      if (!source) return null;
      const columns = source.columns || [];
      const rows = source.rows || [];
      if (!columns.length) return null;
      return { columns, rows };
    },

    exportActiveTable(format) {
      this.openExportModal({ source: 'table', format });
    },

    exportQueryResult(format) {
      this.openExportModal({ source: 'sql', format });
    },

    downloadExport({ columns, rows }, baseName, format) {
      const mod = window.MysqlClientExportGrid;
      const kind = String(format || '').toLowerCase();
      if (kind === 'json') {
        mod.downloadText(
          mod.safeFilename(baseName, 'json'),
          mod.toJson(columns, rows),
          'application/json;charset=utf-8'
        );
        this.toast(`Exported ${rows.length} row(s) as JSON`, 'success');
        return;
      }
      mod.downloadText(
        mod.safeFilename(baseName, 'csv'),
        mod.toCsv(columns, rows),
        'text/csv;charset=utf-8'
      );
      this.toast(`Exported ${rows.length} row(s) as CSV`, 'success');
    },

    openExportModal({ source = 'table', format = 'csv' } = {}) {
      const session = this.activeSession;
      if (!session) {
        this.toast('Connect a session first', 'error');
        return;
      }

      let baseName = 'query-result';
      let loadedCount = 0;
      let canAll = true;

      if (source === 'table') {
        const view = this.activeTableView?.();
        if (!view?.table || !view?.database) {
          this.toast('Open a table first', 'error');
          return;
        }
        baseName = `${view.database}.${view.table}`;
        loadedCount = (view.rows || []).length;
        if (!loadedCount && !view.columns?.length) {
          this.toast('Nothing to export', 'error');
          return;
        }
      } else {
        const tab = this.activeQueryTab?.();
        const result = tab?.result;
        if (!result || result.kind !== 'rows' || !result.columns?.length) {
          this.toast('No result rows to export', 'error');
          return;
        }
        baseName = 'query-result';
        loadedCount = (result.rows || []).length;
        // Manual LIMIT queries are already complete — "all" re-runs the same SQL.
        canAll = true;
      }

      this.exportOpen = true;
      this.exportRunning = false;
      this.exportError = null;
      this.exportResult = null;
      this.exportForm = window.MysqlClientExportGrid.blankExportForm({
        source,
        format: format === 'json' ? 'json' : 'csv',
        scope: loadedCount ? 'loaded' : 'all',
        baseName,
        batchSize: 1000,
        fileMode: 'single',
        relativePath: '',
      });
      this.exportMeta = {
        loadedCount,
        canAll,
        exportRoot: this.exportMeta?.exportRoot || '',
      };
      void this.refreshExportInfo();
      void this.refreshExportFileList();
    },

    closeExportModal() {
      if (this.exportRunning) return;
      this.exportOpen = false;
    },

    async refreshExportInfo() {
      try {
        const data = await this.api('GET', '/api/export/info');
        this.exportMeta = {
          ...(this.exportMeta || {}),
          exportRoot: data.exportRoot || '',
        };
      } catch (_) {
        /* optional */
      }
    },

    async refreshExportFileList() {
      this.exportFilesLoading = true;
      try {
        const data = await this.api('GET', '/api/export/files?limit=30');
        this.exportRecentFiles = data.files || [];
        if (data.exportRoot) {
          this.exportMeta = {
            ...(this.exportMeta || {}),
            exportRoot: data.exportRoot,
          };
        }
      } catch (err) {
        this.exportRecentFiles = [];
      } finally {
        this.exportFilesLoading = false;
      }
    },

    exportFormatBytes(n) {
      return window.MysqlClientExportGrid.formatBytes(n);
    },

    estimatedExportBatches() {
      const form = this.exportForm || {};
      const batch = Math.max(100, Number(form.batchSize) || 1000);
      if (form.scope === 'loaded') {
        const n = this.exportMeta?.loadedCount || 0;
        return Math.max(1, Math.ceil(n / batch) || 1);
      }
      return null;
    },

    async runRichExport() {
      const session = this.activeSession;
      const form = this.exportForm;
      if (!session || !form || this.exportRunning) return;

      const batchSize = Math.min(10000, Math.max(100, Math.round(Number(form.batchSize) || 1000)));
      form.batchSize = batchSize;

      this.exportRunning = true;
      this.exportError = null;
      this.exportResult = null;

      try {
        const body = {
          connectionId: session.connection.id,
          scope: form.scope,
          source: form.source,
          format: form.format,
          fileMode: form.fileMode,
          batchSize,
          baseName: form.baseName,
          relativePath: form.relativePath,
        };

        if (form.source === 'table') {
          const view = this.activeTableView?.();
          body.database = view?.database;
          body.table = view?.table;
          body.sortColumn = view?.sortColumn || null;
          body.sortDir = view?.sortDir || 'asc';
          body.filterColumn = view?.filterColumn || null;
          body.filterValue = view?.filterValue || '';
          if (form.scope === 'loaded') {
            body.columns = view?.columns || [];
            body.rows = view?.rows || [];
          }
        } else {
          const tab = this.activeQueryTab?.();
          const result = tab?.result;
          body.database = session.activeDatabase || null;
          // Prefer the bare statement used for lazy pages; else strip page LIMIT/OFFSET.
          if (tab?.resultBaseSql) {
            body.sql = tab.resultBaseSql;
          } else if (result?.paginated && result?.sql) {
            body.sql = String(result.sql).replace(
              /\s+LIMIT\s+\d+(\s+OFFSET\s+\d+)?\s*$/i,
              ''
            );
          } else {
            body.sql = result?.sql || '';
          }
          if (form.scope === 'loaded') {
            body.columns = result?.columns || [];
            body.rows = result?.rows || [];
          }
        }

        const data = await this.api('POST', '/api/export/run', body);
        this.exportResult = data;
        this.exportMeta = {
          ...(this.exportMeta || {}),
          exportRoot: data.exportRoot || this.exportMeta?.exportRoot || '',
        };

        if (data.browserDownload && data.files?.length === 1) {
          this.downloadExportFile(data.files[0].relativePath);
          this.toast(
            `Exported ${data.totalRows} row(s) · downloaded + saved under data/exports/`,
            'success'
          );
        } else {
          this.toast(
            `Exported ${data.totalRows} row(s) in ${data.files?.length || 0} file(s) under data/exports/`,
            'success',
            { title: 'Saved to data/exports' }
          );
        }
        void this.refreshExportFileList();
      } catch (err) {
        this.exportError = err.message || 'Export failed';
        this.toast(this.exportError, 'error');
      } finally {
        this.exportRunning = false;
      }
    },

    downloadExportFile(relativePath) {
      if (!relativePath) return;
      const url = `/api/export/download?path=${encodeURIComponent(relativePath)}`;
      const link = document.createElement('a');
      link.href = url;
      link.download = '';
      document.body.appendChild(link);
      link.click();
      link.remove();
    },

    async copyExportPath(text) {
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
        this.toast('Path copied', 'success');
      } catch (_) {
        this.toast('Clipboard unavailable', 'error');
      }
    },

    /** Quick one-click browser download of currently loaded rows (no modal). */
    quickExportLoaded(source, format) {
      if (source === 'table') {
        const view = this.activeTableView?.();
        const payload = this.exportGridPayload(view);
        if (!payload) {
          this.toast('Nothing to export', 'error');
          return;
        }
        const base = [view.database, view.table].filter(Boolean).join('.') || 'table';
        this.downloadExport(payload, base, format);
        return;
      }
      const tab = this.activeQueryTab?.();
      const result = tab?.result;
      if (!result || result.kind !== 'rows') {
        this.toast('No result rows to export', 'error');
        return;
      }
      const payload = this.exportGridPayload(result);
      if (!payload) {
        this.toast('Nothing to export', 'error');
        return;
      }
      this.downloadExport(payload, 'query-result', format);
    },
  },
};
