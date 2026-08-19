// Test shim: JavaScriptCore (osascript) has no `self`, and the modules bind to
// `self` so they work identically in a page, a worker and here. Point it at the
// global so every js/*.js file loads unchanged.
var self = this;
