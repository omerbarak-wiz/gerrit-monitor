// Copyright 2019 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as browser from './browser.js';
import * as config from './config.js';
import * as gerrit from './gerrit.js';
import * as messages from './messages.js';
import * as notifications from './notifications.js';

// Variable used to cache the results of fetchReviews.
var fetchCache = {};

// Separate cache for account info (rarely changes).
var accountCache = {};
var ACCOUNT_CACHE_DURATION_IN_MILLISECONDS = 30 * 60 * 1000; // 30 minutes

// Returns cached account info or fetches it.
async function getCachedAccount(host) {
  const now = new Date();
  if (accountCache[host]) {
    const [timestamp, account] = accountCache[host];
    if (now - timestamp < ACCOUNT_CACHE_DURATION_IN_MILLISECONDS) {
      return account;
    }
  }
  const account = await gerrit.fetchAccount(host);
  accountCache[host] = [new Date(), account];
  return account;
}

// Returns stale cached results if available (even if expired).
function getStaleCachedResults(hosts) {
  let results = new Array();
  let errors = new Array();
  let hasAny = false;

  for (const host of hosts) {
    if (fetchCache[host]) {
      hasAny = true;
      const [timestamp, cached] = fetchCache[host];
      if (cached.error) {
        errors.push({ host: host, error: cached.error });
      } else {
        results.push(cached.reviews);
      }
    }
  }

  if (!hasAny) return null;

  return {
    results: new gerrit.SearchResults(results),
    errors: errors,
    stale: true,
  };
}

// Fetches information about interesting CLs.
async function fetchCls(hosts) {
  if (hosts.length === 0) {
    throw new Error(config.NO_HOST_ALLOWED);
  }

  const now = new Date();
  const options = await browser.loadOptions();

  // Fetch results from all hosts in parallel.
  let results = new Array();
  let errors = new Array();
  await Promise.allSettled(hosts.map(async (host) => {
    if (fetchCache[host]) {
      const [timestamp, cached] = fetchCache[host];
      if (now - timestamp < config.REVIEW_CACHE_DURATION_IN_MILLISECONDS) {
        if (cached.error) {
          errors.push({ host: host, error: cached.error });
        } else {
          results.push(cached.reviews);
        }
        return;
      }
    }

    try {
      const account = await getCachedAccount(host);
      const reviews = await gerrit.fetchReviews(host, account, options);
      fetchCache[host] = [new Date(), {reviews: reviews}];
      results.push(reviews);
    } catch (error) {
      fetchCache[host] = [new Date(), {error: error}];
      errors.push({ host: host, error: error });
    }
  }));

  return {
    results: new gerrit.SearchResults(results),
    errors: errors,
  };
};

async function fetchAndUpdate(hosts) {
  // Fetch results.
  let results = await fetchCls(hosts);

  // Update the badge.
  update(results);

  // Persist results to storage so they survive service worker restarts.
  await browser.setLocalStorage('cachedResults', JSON.parse(JSON.stringify(results)));

  // Send any notifications.
  await notifications.notify(results.results, results.errors);

  return results;
}

// Updates the badge.
function update(wrapper) {
  // Re-schedule the function to be called later, cancelling any pending
  // alarm (as this is called when the user open the popup menu).
  chrome.alarms.clear('auto-refresh');
  chrome.alarms.create('auto-refresh', {
    delayInMinutes: config.REFRESH_DELAY_IN_MINUTES,
  });

  var updateData = null;
  if (wrapper.errors.length !== 0) {
    updateData = {
      text: '!',
      color: 'red',
      title: 'Error: ' + wrapper.errors[0].error.message,
      icon: {
        '24': 'img/ic_assignment_late_black_24dp_1x.png',
        '48': 'img/ic_assignment_late_black_24dp_2x.png',
      },
    };
  } else {
    var categories = wrapper.results.getCategoryMap();
    messages.SECTION_ORDERING.forEach(function(attention) {
      if (updateData != null)
        return;

      if (!categories.has(attention))
        return;

      var data = messages.BADGE_DATA[attention];
      if (data === null)
        return;

      var count = categories.get(attention).length;
      updateData = {
        text: String(count),
        icon: data.icon,
        title: data.formatTitle(count),
        color: data.color,
      };
    });
  }

  if (updateData === null)
    updateData = messages.DEFAULT_BADGE_DATA;

  browser.updateBadge(updateData);
};

// Automatically refresh the badge.
function onAlarm() {
  browser.loadOptions().then(function(options) {
    return gerrit.fetchAllowedInstances(options)
      .then(function(instances) {
        return fetchAndUpdate(
            instances.map(function(instance) { return instance.host; }));
      });
  }).catch(function(error) { /* do nothing */ });
};

// Creates a message listener that turns browser channel message into
// calls on the given object. All methods must return a promise and
// the result of the promise will be returned to the sender.
function newMessageProxy(handler) {
  return function(request, sender, reply) {
    var hasResponded = false;
    (handler[request[0]]).apply(handler, request.slice(1))
        .then(function(value) {
          reply({value: JSON.parse(JSON.stringify(value))});
          hasResponded = true;
        }, function(error) {
          reply({error: String(error)});
          hasResponded = true;
        });
    // If the promise is not yet fullfilled, return true to indicate that
    // the reply will be asynchronous.
    return !hasResponded;
  };
};

// Handler object for responding to requests from the popup.
class RequestProxy {
  constructor() {}

  // Returns the search results displayed in the popup. If stale cached
  // data is available, returns it immediately and refreshes in the
  // background, sending an 'updateResults' message when done.
  getSearchResults(hosts) {
    const stale = getStaleCachedResults(hosts);
    if (stale) {
      // Refresh in background; send updated results to popup when done.
      fetchAndUpdate(hosts).then(function(freshResults) {
        chrome.runtime.sendMessage(['updateResults', freshResults]);
      }).catch(function() { /* popup may have closed */ });
      return Promise.resolve(stale);
    }
    return fetchAndUpdate(hosts);
  }
}

browser.callWhenLoaded(function() {
  browser.addExtensionMessageListener(
      newMessageProxy(new RequestProxy()));

  chrome.alarms.onAlarm.addListener(onAlarm);
  onAlarm();
});
