'use strict';

const q = new URLSearchParams(location.search);
const code = q.get('c') || '';
const url = q.get('u') || '';
const n = Number(code);

let title = 'This page did not load';
let detail = 'Something went wrong while connecting.';

if (code === 'crashed') {
  title = 'This tab stopped working';
  detail = 'The page crashed or ran out of memory.';
} else if (n === -105 || n === -137) {
  title = "Can't find this site";
  detail = 'Check the address for typos.';
} else if (n === -106 || n === -21) {
  title = 'No internet connection';
  detail = 'Check your network and try again.';
} else if (n <= -200 && n > -300) {
  title = 'Connection is not private';
  detail = "This site's security certificate is not valid. That is often just a setup mistake, but someone could also be trying to read what you send. Don't type passwords or card details here.";
  if (url.startsWith('https://')) {
    const proceed = document.getElementById('proceed');
    proceed.hidden = false;
    proceed.addEventListener('click', () => graphium.action('allow-certificate', url));
  }
} else if (n === -102) {
  title = 'This site refused to connect';
} else if (n === -118 || n === -7) {
  title = 'This site took too long to respond';
} else if (n === -20) {
  title = 'Blocked';
  detail = 'This page was blocked from loading here.';
}

document.getElementById('title').textContent = title;
document.getElementById('detail').textContent = detail;
document.getElementById('url').textContent = url;
document.getElementById('code').textContent = code && code !== 'crashed' ? `${q.get('d') || 'Error'} (${code})` : '';
document.title = title;

const retry = document.getElementById('retry');
if (/^(https?|file):/i.test(url)) retry.addEventListener('click', () => location.assign(url));
else retry.hidden = true;
