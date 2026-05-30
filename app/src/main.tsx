import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { Landing } from './components/Landing';
import './styles.css';

// 备案审核期开关：VITE_BEIAN_MODE=1 时，对外只渲染中性静态介绍页（无登录入口、不调后端），
// 以降低个人 ICP 备案被打回的概率。备案通过后把该变量设回 0（或留空）即恢复完整应用。
const BEIAN_MODE = (import.meta as any).env?.VITE_BEIAN_MODE === '1';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {BEIAN_MODE ? <Landing /> : <App />}
  </React.StrictMode>,
);
