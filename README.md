<p align="center">
  <img src="baremetal-logo.png"
       alt="Heritage Pin Logo"
       width="380">
</p>

<h1 align="center">BareMetal</h1>

<p align="center">
  <b>M# Hackathon 2026</b>
  &nbsp;·&nbsp;
  Problem Statement <b>P07</b>
</p>

<h3 align="center">HERITAGE PIN</h3>

<p align="center">
  <i>Culture, on its own terms.</i>
</p>

<br>

<p align="center">
  A location-first digital atlas connecting people with India's artisans,
  cultural custodians, traditional crafts, and the stories behind them.
</p>

---

## 🌍 About

**Heritage Pin** is a location-first digital atlas designed to make India's living cultural heritage discoverable through the people and places that keep it alive.

Instead of treating traditional crafts as generic products in a tourism catalogue, Heritage Pin anchors custodians to their geographic location and puts their identity, craft, story, and community at the center of discovery.

The platform combines a lightweight interactive web map with a **Telegram-based onboarding system**, allowing artisans to create a Heritage Pin without downloading or learning a complex application.

---

## 🎯 The Problem

Traditional crafts and cultural knowledge are often difficult to discover digitally.

Existing tourism and marketplace platforms tend to focus on:

- Products rather than people
- Tourist experiences rather than custodians
- Generic locations rather than cultural geography
- Complex digital storefronts rather than simple onboarding

This can make artisans dependent on intermediaries while separating their craft from the place and story that give it meaning.

Heritage Pin approaches the problem from the opposite direction:

> **Put the people and their places on the map first.**

---

## 💡 The Solution

Heritage Pin works as a **location-first cultural discovery platform**.

Instead of asking an artisan to build an online store, the system allows them to interact with a simple Telegram bot.

The onboarding process collects:

- Public name
- Traditional craft
- Geographic location
- Craft video
- Voice story

The backend then creates a unique Heritage Pin and stores the profile in the platform database.

Visitors can subsequently discover these profiles through an interactive map.

---

# 🧭 How It Works

```text
                         ARTISAN
                            │
                            ▼
                   ┌─────────────────┐
                   │  Telegram Bot   │
                   │                 │
                   │ Name            │
                   │ Craft           │
                   │ GPS Location    │
                   │ Video           │
                   │ Voice Story     │
                   └────────┬────────┘
                            │
                            ▼
                   ┌─────────────────┐
                   │ Flask Backend   │
                   │                 │
                   │ Validation      │
                   │ Geofencing      │
                   │ Pin Generation  │
                   │ Authentication  │
                   └────────┬────────┘
                            │
                   ┌────────┴────────┐
                   ▼                 ▼
            Firebase Auth      Firebase RTDB
                   │                 │
                   └────────┬────────┘
                            │
                            ▼
                     HERITAGE PIN
                            │
                            ▼
                   ┌─────────────────┐
                   │ Web Application │
                   │                 │
                   │ HTML/CSS/JS     │
                   │ Leaflet.js      │
                   └────────┬────────┘
                            │
                            ▼
                    INTERACTIVE MAP
                            │
              ┌─────────────┼─────────────┐
              ▼             ▼             ▼
           Search        Explore       Profile
              │             │             │
              └─────────────┼─────────────┘
                            ▼
                    Direct Discovery
