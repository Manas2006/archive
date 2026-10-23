// Web app page: the library (also served as index.html). The platform module must load first: it installs the
// chrome shim and the in-page background that the page module talks to.
import '@/platform/web';
import '@/entrypoints/library/main';
