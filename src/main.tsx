import React from 'react';
import {createRoot} from 'react-dom/client';
import {DeskApp} from './DeskApp';
import './style.css';
createRoot(document.getElementById('root')!).render(<DeskApp/>);
