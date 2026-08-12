/**
 * About / credits for MySQL Studio Web (sidebar + modal).
 */
window.MysqlStudioCredits = {
  state() {
    return {
      creditsOpen: false,
    };
  },

  /** Edit these links when you publish the project. */
  info: {
    appName: "MySQL Studio Web",
    owner: "Amrish Kakadiya",
    tagline: "Lightweight local web MySQL studio",
    github: "https://github.com/amrishkakadiya/mysql-studio-web",
    linkedin: "https://www.linkedin.com/in/amrish-kakadiya",
  },

  methods: {
    openCredits() {
      this.creditsOpen = true;
    },

    closeCredits() {
      this.creditsOpen = false;
    },

    creditsInfo() {
      return window.MysqlStudioCredits.info;
    },
  },
};
