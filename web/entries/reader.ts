// Web app page: the PDF reader. The platform module must load first: it installs the
// chrome shim and the in-page background that the page module talks to.
import '@/platform/web';
import '@/entrypoints/reader/main';
