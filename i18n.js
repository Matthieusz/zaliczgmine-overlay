(function (global) {
  "use strict";

  // English is the fallback language
  const messages = {
    en: {
      "app.subtitle": "Map overlay for Komoot and VeloPlanner",
      "communes.visitedLabel": "Visited communes",
      "map.checking": "Checking...",
      "map.supportedPlanners": "Supported route planners",
      "account.title": "{brand} account",
      "account.noneSelected": "No account selected",
      "account.searchPlaceholder": "Username or user ID",
      "account.search": "Search",
      "account.searchHint": "Search for your account and select it from the list.",
      "communes.visibility": "Commune visibility",
      "gpx.title": "GPX tracks",
      "gpx.noFile": "No file selected",
      "gpx.choose": "Choose",
      "gpx.add": "Add track",
      "gpx.removeAll": "Remove all",
      "gpx.importHint": "Imported tracks appear on the map as blue lines.",
      "gpx.emptyHint": "GPX tracks appear as blue lines on the map.",
      "gpx.remove": "Remove",
      "gpx.chooseFile": "Choose a GPX file",
      "gpx.readError": "Could not read the GPX file",
      "gpx.added": "GPX added to the map",
      "gpx.saved": "GPX saved",
      "gpx.removedFromMap": "GPX removed from the map",
      "gpx.removedFromStorage": "Saved GPX removed",
      "account.queryRequired": "Enter a username or user ID",
      "account.searching": "Searching for users…",
      "account.noResults": "No users found",
      "account.selectResult": "Select an account from the list",
      "account.saveError": "Could not save the account",
      "communes.hide": "Hide communes",
      "communes.show": "Show communes",
      "map.connectionError": "Could not connect to the planner map",
      "map.connected": "Connected to map",
      "map.disconnected": "Map disconnected",
      "api.invalidRequest": "Invalid request parameters",
      "api.unsupportedCountry": "Unsupported country",
      "api.userNotFound": "User not found",
      "api.fetchError": "Could not fetch data",
      "api.error": "API error",
      "storage.error": "Could not access saved settings or tracks",
      "api.invalidResponse": "Invalid API response",
      "extension.noResponse": "The extension did not respond",
      "extension.unexpectedError": "Something went wrong. Please try again.",
      "gpx.invalidFile": "Invalid GPX file",
      "gpx.noTrack": "The GPX file contains no route or track",
      "communes.hideBoundaries": "Hide commune boundaries",
      "communes.showBoundaries": "Show commune boundaries",
      "communes.boundaries": "Commune boundaries",
      "account.selectInExtension": "Select an account in the extension",
      "map.notFound": "Map not found",
      "extension.unknownAction": "Unknown action",
      "account.invalidId": "No valid {brand} user ID selected",
      "communes.boundariesError": "Could not fetch detailed commune boundaries for the route",
      "communes.invalidGeometry": "Invalid commune geometry",
      "extension.unsupportedPage": "The extension only works when planning or editing a route",
      "account.selected": "Selected: {username} (ID: {id})",
      "account.userIdFallback": "user ID {id}",
      "account.userIdTitle": "User ID: {id}",
      "gpx.savedCount": "Saved GPX files: {count}",
      "account.saved": "Account {username} saved",
      "communes.loadedCount": "Loaded {count} communes",
      "account.savedOpenMap": "Account {username} saved. Open a map to load communes.",
      "communes.nowVisible": "Communes are now visible",
      "communes.nowHidden": "Communes are now hidden",
      "communes.visitedLoadError": "Could not load visited communes: {error}",
      "communes.loadedSummary": "Communes loaded. Visited: {count}",
      "communes.visitedCount": "{count} visited communes",
      "account.mapSummary": "{brand} · {username} · {count} visited communes in Poland",
      "language.title": "Language",
      "language.automatic": "Automatic (browser)",
      "app.title": "{brand} — route planners",
      "language.saved": "Language saved. Reopen this popup and refresh the planner to apply it.",
      "language.saveError": "Could not save the language",
    },
    pl: {
      "app.subtitle": "Nakładka mapy dla Komoot i VeloPlanner",
      "communes.visitedLabel": "Zaliczonych gmin",
      "map.checking": "Sprawdzanie...",
      "map.supportedPlanners": "Obsługiwane planery tras",
      "account.title": "Konto {brand}",
      "account.noneSelected": "Nie wybrano konta",
      "account.searchPlaceholder": "Nick lub ID użytkownika",
      "account.search": "Szukaj",
      "account.searchHint": "Wyszukaj i wybierz swoje konto z listy.",
      "communes.visibility": "Widoczność gmin",
      "gpx.title": "Trasy GPX",
      "gpx.noFile": "Brak pliku",
      "gpx.choose": "Wybierz",
      "gpx.add": "Dodaj trasę",
      "gpx.removeAll": "Usuń wszystkie",
      "gpx.importHint": "Zaimportowane trasy pojawią się na mapie jako niebieskie linie.",
      "gpx.emptyHint": "GPX będzie widoczny jako niebieska linia na mapie.",
      "gpx.remove": "Usuń",
      "gpx.chooseFile": "Wybierz plik GPX",
      "gpx.readError": "Nie udało się odczytać pliku GPX",
      "gpx.added": "Dodano GPX do mapy",
      "gpx.saved": "GPX zapisany",
      "gpx.removedFromMap": "Usunięto GPX z mapy",
      "gpx.removedFromStorage": "Usunięto zapisany GPX",
      "account.queryRequired": "Wpisz nick lub ID użytkownika",
      "account.searching": "Wyszukiwanie użytkowników…",
      "account.noResults": "Nie znaleziono użytkowników",
      "account.selectResult": "Wybierz konto z listy",
      "account.saveError": "Nie udało się zapisać użytkownika",
      "communes.hide": "Ukryj gminy",
      "communes.show": "Pokaż gminy",
      "map.connectionError": "Nie można połączyć się z mapą planera",
      "map.connected": "Połączono z mapą",
      "map.disconnected": "Brak połączenia z mapą",
      "api.invalidRequest": "Nieprawidłowe parametry zapytania",
      "api.unsupportedCountry": "Nieobsługiwany kraj",
      "api.userNotFound": "Nie znaleziono użytkownika",
      "api.fetchError": "Nie udało się pobrać danych",
      "api.error": "Błąd API",
      "storage.error": "Nie udało się odczytać lub zapisać ustawień albo tras",
      "api.invalidResponse": "Nieprawidłowa odpowiedź z API",
      "extension.noResponse": "Brak odpowiedzi rozszerzenia",
      "extension.unexpectedError": "Wystąpił nieoczekiwany błąd. Spróbuj ponownie.",
      "gpx.invalidFile": "Nieprawidłowy plik GPX",
      "gpx.noTrack": "GPX nie zawiera trasy ani śladu",
      "communes.hideBoundaries": "Ukryj granice gmin",
      "communes.showBoundaries": "Pokaż granice gmin",
      "communes.boundaries": "Granice gmin",
      "account.selectInExtension": "Wybierz konto w rozszerzeniu",
      "map.notFound": "Mapa nie została znaleziona",
      "extension.unknownAction": "Nieznana akcja",
      "account.invalidId": "Nie ustawiono poprawnego ID użytkownika {brand}",
      "communes.boundariesError": "Nie udało się pobrać dokładnych granic gmin dla trasy",
      "communes.invalidGeometry": "Nieprawidłowa geometria gminy",
      "extension.unsupportedPage": "Rozszerzenie dziala tylko podczas planowania lub edycji trasy",
      "account.selected": "Wybrano: {username} (ID: {id})",
      "account.userIdFallback": "użytkownik o ID {id}",
      "account.userIdTitle": "ID użytkownika: {id}",
      "gpx.savedCount": "Zapisane pliki GPX: {count}",
      "account.saved": "Zapisano konto {username}",
      "communes.loadedCount": "Załadowano {count} gmin",
      "account.savedOpenMap": "Zapisano konto {username}. Otwórz mapę, aby załadować gminy.",
      "communes.nowVisible": "Gminy są teraz widoczne",
      "communes.nowHidden": "Gminy są teraz ukryte",
      "communes.visitedLoadError": "Nie udało się pobrać zaliczonych gmin: {error}",
      "communes.loadedSummary": "Załadowano gminy. Zaliczone: {count}",
      "communes.visitedCount": "{count} zaliczonych gmin",
      "account.mapSummary": "{brand} · {username} · {count} zaliczonych gmin w Polsce",
      "language.title": "Język",
      "language.automatic": "Automatyczny (przeglądarka)",
      "app.title": "{brand} — planery tras",
      "language.saved":
        "Język zapisany. Otwórz ponownie panel i odśwież planer, aby zastosować zmianę.",
      "language.saveError": "Nie udało się zapisać języka",
    },
  };

  Object.values(messages).forEach(Object.freeze);
  Object.freeze(messages);
  let language = resolveLanguage();

  function resolveLanguage(preference, browserLanguage = global.navigator?.language) {
    if (Object.hasOwn(messages, preference)) return preference;
    const browserLocale = (browserLanguage || "").toLowerCase().split("-")[0];

    return Object.hasOwn(messages, browserLocale) ? browserLocale : "en";
  }

  function t(key, values = {}) {
    const template = messages[language]?.[key] ?? messages.en[key] ?? key;

    return template.replace(/\{(\w+)\}/g, (match, name) =>
      String(name === "brand" ? brand() : (values[name] ?? match)),
    );
  }

  function brand() {
    return language === "pl" ? "ZaliczGmine.pl" : "TickMyRide.com";
  }

  global.ZaliczGmineI18n = {
    t,
    brand,
    resolveLanguage,
    messages,
    get language() {
      return language;
    },
    get apiBase() {
      return language === "pl" ? "https://zaliczgmine.pl/api/" : "https://tickmyride.com/api/";
    },
    setLanguage(preference, browserLanguage) {
      language = resolveLanguage(preference, browserLanguage);
    },
  };
})(globalThis);
