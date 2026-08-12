const CLOCK_FORMAT_KEY = 'mysqlClient.clock12Hour';

window.MysqlClientClock = {
  state() {
    return {
      clock12Hour: localStorage.getItem(CLOCK_FORMAT_KEY) === '1',
      localClock: '',
      utcClock: '',
      clockTimer: null,
    };
  },

  methods: {
    initClock() {
      this.updateClocks();
      clearInterval(this.clockTimer);
      this.clockTimer = setInterval(() => this.updateClocks(), 1000);
    },

    updateClocks() {
      const now = new Date();
      const options = {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: this.clock12Hour,
      };
      this.localClock = new Intl.DateTimeFormat(undefined, options).format(now);
      this.utcClock = new Intl.DateTimeFormat('en-GB', {
        ...options,
        timeZone: 'UTC',
      }).format(now);
    },

    toggleClockFormat() {
      this.clock12Hour = !this.clock12Hour;
      localStorage.setItem(CLOCK_FORMAT_KEY, this.clock12Hour ? '1' : '0');
      this.updateClocks();
    },
  },
};
