// messages.html was removed (SI-66): send old links to the Care Log, keeping ?as=parent and
// ?demo=1. replace() keeps the old page out of the tab's history.
window.location.replace(`care-log.html${window.location.search}`);
