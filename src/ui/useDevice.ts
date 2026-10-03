import { useEffect, useState } from 'react';

/** phone = smallest screen side < 600 CSS px (portrait or landscape) */
export function isPhone() {
  return Math.min(window.innerWidth, window.innerHeight) < 600;
}

export function useIsPhone() {
  const [phone, setPhone] = useState(isPhone());
  useEffect(() => {
    const on = () => setPhone(isPhone());
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return phone;
}
