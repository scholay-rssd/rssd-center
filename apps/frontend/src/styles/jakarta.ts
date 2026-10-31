import localFont from 'next/font/local';

// Keep Postiz's typeface while making image builds independent of Google Fonts.
// The original font files and SIL license are shipped together in public/fonts.
export const jakartaSans = localFont({
  src: [
    { path: '../../public/fonts/plus-jakarta-sans/regular.ttf', weight: '200 800', style: 'normal' },
    { path: '../../public/fonts/plus-jakarta-sans/italic.ttf', weight: '200 800', style: 'italic' },
  ],
  display: 'swap',
});
