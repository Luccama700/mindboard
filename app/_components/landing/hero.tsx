"use client";

import Link from "next/link";
import { DOCK_INPUT_ID, Desk } from "./desk";

// The first screen: three words, and the product itself at small scale. The
// desk beside the headline is not a picture; it runs the app's own capture
// grammar on whatever is typed into it.
export function Hero() {
  return (
    <section className="landing-hero landing-crt">
      <header className="landing-topbar">
        <p className="landing-mark">
          <i aria-hidden />
          mindboard
        </p>
        <Link href="/login" className="landing-signin">
          sign in <span aria-hidden>→</span>
        </Link>
      </header>

      <div className="landing-hero-grid">
        <div className="landing-pitch">
          <h1 className="landing-h1">
            <span>put it</span>
            <span>
              down.
              <i className="landing-caret" aria-hidden />
            </span>
          </h1>
          <p className="landing-lede">
            mindboard holds the tasks, money, groceries, people and half-ideas
            you are carrying around. open it, type one line, get back to your
            day.
          </p>
          <div className="landing-actions">
            <Link href="/login" className="landing-cta">
              get your board <span aria-hidden>→</span>
            </Link>
            <button
              type="button"
              className="landing-ghost"
              onClick={() => document.getElementById(DOCK_INPUT_ID)?.focus()}
            >
              <span>or try it first</span>
              <span aria-hidden>try it ↓</span>
            </button>
          </div>
          <p className="landing-note">
            any google account. a workspace of your own.
          </p>
        </div>

        <Desk />
      </div>
    </section>
  );
}
