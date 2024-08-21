import { resetStore } from 'loot-core/src/mocks/redux';

import { installPolyfills } from './polyfills';

installPolyfills();

/* eslint-disable @typescript-eslint/no-this-alias */
if (!Element.prototype.closest) {
  Element.prototype.closest = function (selector) {
    let el = this;
    do {
      if (el.matches(selector)) return el;
      el = el.parentElement || el.parentNode;
    } while (el !== null && el.nodeType === 1);
    return null;
  };
}

global.IS_TESTING = true;
global.Actual = {};

vi.mock('react-virtualized-auto-sizer', () => ({
  default: props => {
    return props.children({ height: 1000, width: 600 });
  },
}));

global.Date.now = () => 123456789;

global.__resetWorld = () => {
  resetStore();
};

process.on('unhandledRejection', reason => {
  console.log('REJECTION', reason);
});

global.afterEach(() => {
  global.__resetWorld();
});
