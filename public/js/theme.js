/**
 * UI theme (dark default / light) for the Alpine root store (Chunk 7).
 */
window.MysqlClientTheme = {
  STORAGE_KEY: 'mysqlClient.uiTheme',

  state() {
    let saved = 'dark';
    try {
      saved = localStorage.getItem(this.STORAGE_KEY) || 'dark';
    } catch (_) {
      saved = 'dark';
    }
    return {
      uiTheme: saved === 'light' ? 'light' : 'dark',
    };
  },

  methods: {
    initTheme() {
      this.applyTheme();
    },

    isDarkTheme() {
      return this.uiTheme !== 'light';
    },

    applyTheme() {
      const dark = this.isDarkTheme();
      const root = document.documentElement;
      root.classList.toggle('dark', dark);
      root.classList.toggle('light', !dark);
      root.style.colorScheme = dark ? 'dark' : 'light';
      try {
        localStorage.setItem(
          window.MysqlClientTheme.STORAGE_KEY,
          dark ? 'dark' : 'light'
        );
      } catch (_) {
        // ignore quota / private mode
      }
      this.syncEditorTheme();
    },

    toggleTheme() {
      this.uiTheme = this.isDarkTheme() ? 'light' : 'dark';
      this.applyTheme();
      this.toast?.(
        this.isDarkTheme() ? 'Dark theme' : 'Light theme',
        'info',
        { duration: 1800 }
      );
    },

    syncEditorTheme() {
      const mod = window.MysqlClientQueryEditor;
      if (!mod?.cm) return;
      const theme = this.isDarkTheme() ? 'material-darker' : 'default';
      if (mod.cm.getOption('theme') !== theme) {
        mod.cm.setOption('theme', theme);
      }
      this.$nextTick?.(() => mod.cm.refresh());
    },
  },
};
