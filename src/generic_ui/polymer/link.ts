Polymer({
  handleKey: () => {
    // fire both on-click (builtin) and on-tap (added by polymer) handlers
    this.click();
    this.fire('tap');
  }
});
