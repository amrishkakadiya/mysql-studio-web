/**
 * UI / editor font settings (persisted in data/config SQLite via /api/settings).
 */
window.MysqlClientAppSettings = {
  UI_FONTS: [
    { id: 'ui-sans-serif, system-ui, sans-serif', label: 'System UI' },
    { id: 'Georgia, "Times New Roman", serif', label: 'Georgia Serif' },
    { id: '"Segoe UI", Tahoma, sans-serif', label: 'Segoe UI' },
    { id: 'Roboto, "Helvetica Neue", Arial, sans-serif', label: 'Roboto' },
    { id: 'Inter, ui-sans-serif, system-ui, sans-serif', label: 'Inter' },
  ],
  EDITOR_FONTS: [
    {
      id: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      label: 'System Mono',
    },
    { id: '"JetBrains Mono", Menlo, Consolas, monospace', label: 'JetBrains Mono' },
    { id: '"Fira Code", Menlo, Consolas, monospace', label: 'Fira Code' },
    { id: 'Menlo, Monaco, Consolas, monospace', label: 'Menlo / Monaco' },
    { id: '"Courier New", Courier, monospace', label: 'Courier New' },
  ],

  defaults() {
    return {
      ui_font_family: 'ui-sans-serif, system-ui, sans-serif',
      ui_font_size: '14',
      editor_font_family: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      editor_font_size: '13',
    };
  },

  state() {
    return {
      settingsOpen: false,
      settingsSaving: false,
      uiFontMenuOpen: false,
      editorFontMenuOpen: false,
      appSettings: this.defaults(),
      settingsForm: this.defaults(),
      uiFontOptions: this.UI_FONTS,
      editorFontOptions: this.EDITOR_FONTS,
    };
  },

  methods: {
    async loadAppSettings() {
      try {
        const data = await this.api('GET', '/api/settings');
        this.appSettings = { ...this.defaults(), ...(data.settings || {}) };
        this.settingsForm = { ...this.appSettings };
        this.applyAppSettings();
      } catch (err) {
        console.warn('Failed to load settings', err.message || err);
        this.appSettings = this.defaults();
        this.settingsForm = { ...this.appSettings };
        this.applyAppSettings();
      }
    },

    defaults() {
      return window.MysqlClientAppSettings.defaults();
    },

    fontOptionLabel(options, value) {
      const list = options || [];
      const hit = list.find((o) => o.id === value);
      return hit ? hit.label : value || 'Font';
    },

    openSettings() {
      this.settingsForm = { ...this.appSettings };
      this.uiFontMenuOpen = false;
      this.editorFontMenuOpen = false;
      this.settingsOpen = true;
      this.$nextTick?.(() => this.previewSettingsForm());
    },

    closeSettings() {
      this.settingsOpen = false;
      this.uiFontMenuOpen = false;
      this.editorFontMenuOpen = false;
      this.settingsForm = { ...this.appSettings };
      this.applyAppSettings();
    },

    selectUiFont(opt) {
      this.settingsForm.ui_font_family = opt.id;
      this.uiFontMenuOpen = false;
      this.previewSettingsForm();
    },

    selectEditorFont(opt) {
      this.settingsForm.editor_font_family = opt.id;
      this.editorFontMenuOpen = false;
      this.previewSettingsForm();
    },

    applyFontVars(settings) {
      const s = { ...this.defaults(), ...(settings || {}) };
      const uiSize = `${Math.min(24, Math.max(10, Number(s.ui_font_size) || 14))}px`;
      const editorSize = `${Math.min(24, Math.max(10, Number(s.editor_font_size) || 13))}px`;
      const root = document.documentElement;

      root.style.setProperty('--ui-font-family', s.ui_font_family);
      root.style.setProperty('--ui-font-size', uiSize);
      root.style.setProperty('--editor-font-family', s.editor_font_family);
      root.style.setProperty('--editor-font-size', editorSize);
      // Drive rem-based Tailwind text sizes from the UI size setting.
      root.style.fontSize = uiSize;

      const mod = window.MysqlClientQueryEditor;
      if (mod?.cm) {
        const wrapper = mod.cm.getWrapperElement?.();
        if (wrapper) {
          wrapper.style.fontFamily = s.editor_font_family;
          wrapper.style.fontSize = editorSize;
        }
        this.$nextTick?.(() => {
          try {
            mod.cm.refresh();
          } catch (_) {
            /* ignore */
          }
        });
      }
    },

    applyAppSettings() {
      this.applyFontVars(this.appSettings);
    },

    /** Live-preview form values without saving. */
    previewSettingsForm() {
      this.applyFontVars(this.settingsForm);
    },

    async saveSettings() {
      this.settingsSaving = true;
      try {
        const data = await this.api('PUT', '/api/settings', this.settingsForm);
        this.appSettings = { ...this.defaults(), ...(data.settings || {}) };
        this.settingsForm = { ...this.appSettings };
        this.applyAppSettings();
        this.settingsOpen = false;
        this.uiFontMenuOpen = false;
        this.editorFontMenuOpen = false;
        this.toast('Settings saved', 'success');
      } catch (err) {
        this.toast(err.message || 'Failed to save settings', 'error');
      } finally {
        this.settingsSaving = false;
      }
    },
  },
};
