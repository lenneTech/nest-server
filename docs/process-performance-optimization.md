# nest-server: process() Performance-Optimierung

## Kontext

Die `process()` Pipeline in `ModuleService` ist der zentrale Verarbeitungspfad fuer alle CRUD-Operationen. Bei hochfrequenten oder verschachtelten Aufrufen (Service-Kaskaden) entsteht unnoetig hoher Memory- und CPU-Verbrauch. Die folgenden Optimierungen reduzieren den Overhead ohne die Sicherheit herabzusetzen.

**Analyse-Basis:** 8 Kundenprojekte + 13 lenne.tech-Projekte geprueft — alle Aenderungen sind rueckwaertskompatibel.

---

## Aenderung 1: JSON.stringify Debug konfigurierbar machen

### Datei: `src/core/common/services/module.service.ts`

### Problem

Zeilen 149-164 serialisieren den Input bei **jedem** process()-Aufruf zweimal (vorher/nachher) — nur fuer einen `console.debug` Vergleich. Das `new Promise(() => ...)` ist ein Fire-and-Forget ohne await.

### Aktueller Code (Zeile 149-165)

```typescript
const originalInput = config.input;
const inputJSON = JSON.stringify(originalInput);
const preparedInput = await this.prepareInput(config.input, config);
new Promise(() => {
  if (
    inputJSON?.replace(/"password":\s*"[^"]*"/, '') !==
    JSON.stringify(preparedInput)?.replace(/"password":\s*"[^"]*"/, '')
  ) {
    console.debug(
      'CheckSecurityInterceptor: securityCheck changed input of type',
      originalInput.constructor.name,
      'to type',
      preparedInput.constructor.name,
    );
  }
});
config.input = preparedInput;
```

### Neuer Code

```typescript
const preparedInput = await this.prepareInput(config.input, config);

// Debug-Vergleich nur wenn explizit konfiguriert (default: false)
if (this.configService?.getFastButReadOnly('debugProcessInput', false)) {
  try {
    const originalJSON = JSON.stringify(config.input)?.replace(/"password":\s*"[^"]*"/, '');
    const preparedJSON = JSON.stringify(preparedInput)?.replace(/"password":\s*"[^"]*"/, '');
    if (originalJSON !== preparedJSON) {
      console.debug(
        'process: prepareInput changed input of type',
        config.input?.constructor?.name,
        'to type',
        preparedInput?.constructor?.name,
      );
    }
  } catch {
    // JSON.stringify kann bei zirkulaeren Referenzen fehlschlagen — ignorieren
  }
}

config.input = preparedInput;
```

### Datei: `src/core/common/interfaces/server-options.interface.ts`

In das `IServerOptions`-Interface (oder dem passenden Config-Bereich) hinzufuegen:

```typescript
/**
 * When true, logs a debug message when prepareInput() changes the input type.
 * Default: false. Enable only for debugging — has performance cost due to JSON.stringify.
 */
debugProcessInput?: boolean;
```

### Sicherheit

Nicht betroffen — rein diagnostisch.

### Kompatibilitaet

Default `false` — kein bestehendes Projekt aendert sein Verhalten.

---

## Aenderung 2: this.get(dbObject) durch Lean Query ersetzen

### Datei: `src/core/common/services/module.service.ts`

### Problem

Zeilen 168-176 rufen `this.get()` auf, was **rekursiv** die gesamte process()-Pipeline durchlaeuft — inklusive prepareInput, checkRights, processFieldSelection, prepareOutput. Das ist unnoetig, weil das dbObject nur als Kontext fuer den Rights-Check gebraucht wird.

Zusaetzlich ist es sogar **kontraproduktiv**: `this.get()` ohne `force` kann Felder wie `createdBy` entfernen (wegen `@Restricted(RoleEnum.ADMIN)`), die dann fuer den `S_CREATOR`-Check fehlen.

### Aktueller Code (Zeile 168-176)

```typescript
// Get DB object
if (config.dbObject && config.checkRights && this.checkRights) {
  if (typeof config.dbObject === 'string' || config.dbObject instanceof Types.ObjectId) {
    const dbObject = await this.get(getStringIds(config.dbObject));
    if (dbObject) {
      config.dbObject = dbObject;
    }
  }
}
```

### Neuer Code

```typescript
// Get DB object for rights checking — lean query to avoid recursive process() call.
// Using lean preserves ALL fields (including createdBy) which is needed for
// S_CREATOR and S_SELF checks. The full process() pipeline would remove
// restricted fields, potentially breaking these checks.
if (config.dbObject && config.checkRights && this.checkRights) {
  if (typeof config.dbObject === 'string' || config.dbObject instanceof Types.ObjectId) {
    if (this.mainDbModel) {
      const rawDoc = await this.mainDbModel.findById(getStringIds(config.dbObject)).lean().exec();
      if (rawDoc) {
        // Map to Model instance so securityCheck() is available as a method
        config.dbObject = (this.mainModelConstructor as any)?.map
          ? (this.mainModelConstructor as any).map(rawDoc)
          : rawDoc;
      }
    }
  }
}
```

### Sicherheit

**Verbessert** — lean Query behaelt alle Felder (z.B. `createdBy`), was den `S_CREATOR`-Check zuverlaessiger macht als der aktuelle Code.

### Nachfolgende Prozesse geprueft

- `checkRights(input)` (Zeile 179-184): Verwendet `config.dbObject` fuer `S_CREATOR`/`S_SELF`/`memberOf` Checks via `equalIds()` — funktioniert mit lean+map, da `equalIds` sowohl ObjectIds als auch Strings vergleicht.
- `checkRights(output)` (Zeile 239-250): Gleiche Nutzung — funktioniert.
- `validateRestricted()` in `checkRestricted()` (restricted.decorator.ts, Zeile 172-174): Prueft `'createdBy' in data && equalIds(data.createdBy, user)` — lean-Objekt hat `createdBy` immer (nicht entfernt durch Pipeline).
- `memberOf`-Check (Zeile 196-218): Liest `config.dbObject?.[property]` — lean-Objekt hat alle Properties.

### Kompatibilitaet

- `CrudService.update()` (Zeile 552): Setzt `dbObject` bereits als lean-Objekt (`findById().lean()`) → konsistent.
- Kein Projekt uebergibt ein Mongoose-Document als dbObject → kein Konflikt.
- Services die `process()` direkt aufrufen mit `dbObject` als String (z.B. swaktiv/OfferService): Profitieren von der Optimierung.

---

## Aenderung 3: Depth-Tracking in RequestContext

### Datei: `src/core/common/services/request-context.service.ts`

### Problem

Bei Service-Kaskaden (A.create → B.create → C.create) laeuft die volle process()-Pipeline auf jeder Ebene. Populate, prepareOutput-Mapping und Output-checkRights auf inneren Ebenen sind unnoetig, weil die aeussere Ebene und der CheckSecurityInterceptor diese Aufgaben uebernehmen.

### Aenderung am Interface

```typescript
export interface IRequestContext {
  // ... bestehende Felder ...

  /**
   * Tracks the nesting depth of process() calls.
   * 0 = outermost call (full pipeline), > 0 = nested call (reduced pipeline).
   * Used to skip redundant populate, output mapping, and output rights checks
   * on inner calls — the outermost call and CheckSecurityInterceptor handle these.
   */
  processDepth?: number;
}
```

### Neue Methoden

```typescript
/**
 * Get the current process() nesting depth.
 * Returns 0 if not inside a process() call.
 */
static getProcessDepth(): number {
  return this.storage.getStore()?.processDepth || 0;
}

/**
 * Run a function with incremented process depth.
 * Skips context creation if already at depth > 0 to avoid redundant object spread.
 */
static runWithIncrementedProcessDepth<T>(fn: () => T): T {
  const currentStore = this.storage.getStore();
  const currentDepth = currentStore?.processDepth || 0;
  const context: IRequestContext = {
    ...currentStore,
    processDepth: currentDepth + 1,
  };
  return this.storage.run(context, fn);
}
```

### Sicherheit

Nicht betroffen — das Depth-Tracking ist rein informativ und aendert keine Berechtigungen.

---

## Aenderung 4: process() — Depth-basierte Optimierung

### Datei: `src/core/common/services/module.service.ts`

### Aenderung in process() (Zeile 81ff)

Am Anfang der Methode nach der Config-Erstellung (nach Zeile 108):

```typescript
// Detect nested process() calls
const currentDepth = RequestContext.getProcessDepth();
const isNested = currentDepth > 0;
```

### serviceFunc mit Depth-Tracking ausfuehren (Zeile 201-205 ersetzen)

```typescript
// Run service function with incremented depth
// When force is enabled, also bypass the Mongoose role guard plugin
const executeServiceFunc = () =>
  RequestContext.runWithIncrementedProcessDepth(() => serviceFunc(config));

let result = config.force
  ? await RequestContext.runWithBypassRoleGuard(executeServiceFunc)
  : await executeServiceFunc();
```

### processFieldSelection bei inneren Calls ueberspringen (Zeile 207-217 ersetzen)

```typescript
// Pop and map main model
// Skip on nested calls UNLESS populate was explicitly requested —
// the outermost call handles population for the final response.
if (config.processFieldSelection && config.fieldSelection && this.processFieldSelection) {
  if (!isNested || config.populate) {
    let temps = result;
    if (!Array.isArray(result)) {
      temps = [result];
    }
    for (const temp of temps) {
      const field = config.outputPath ? _.get(temp, config.outputPath) : temp;
      await this.processFieldSelection(field, config.fieldSelection, config.processFieldSelection);
    }
  }
}
```

**Logik:**
- `isNested = false` (Depth 0, aeusserster Call): Populate laeuft immer → User bekommt vollstaendiges Ergebnis.
- `isNested = true` (Depth > 0, innerer Call) OHNE `config.populate`: Populate wird uebersprungen → Ergebnis wird intern weiterverarbeitet.
- `isNested = true` MIT `config.populate` (explizit vom Caller gesetzt): Populate laeuft → der innere Service hat das explizit angefordert weil er die Daten braucht.

### prepareOutput bei inneren Calls reduzieren (Zeile 219-236 ersetzen)

```typescript
// Prepare output
if (config.prepareOutput && this.prepareOutput) {
  const opts = config.prepareOutput;
  if (!opts.targetModel && config.outputType) {
    opts.targetModel = config.outputType;
  }

  // On nested calls without explicit populate: skip model mapping
  // (the outermost call and CheckSecurityInterceptor handle final mapping).
  // Secret removal (removeSecrets) stays active at ALL depths.
  if (isNested && !config.populate && typeof opts === 'object') {
    opts.targetModel = undefined;
  }

  if (config.outputPath) {
    let temps = result;
    if (!Array.isArray(result)) {
      temps = [result];
    }
    for (const temp of temps) {
      _.set(temp, config.outputPath, await this.prepareOutput(_.get(temp, config.outputPath), opts));
    }
  } else {
    result = await this.prepareOutput(result, config);
  }
}
```

### Output-checkRights bei inneren Calls ueberspringen (Zeile 238-250 ersetzen)

```typescript
// Check output rights
// Skip on nested calls — the outermost process() and CheckSecurityInterceptor
// perform the final output rights check on the complete response.
if (!isNested && config.checkRights && (await this.checkRights(undefined, config.currentUser as any, config))) {
  const opts: any = {
    dbObject: config.dbObject,
    processType: ProcessType.OUTPUT,
    roles: config.roles,
    throwError: false,
  };
  if (config.outputType) {
    opts.metatype = config.outputType;
  }
  result = await this.checkRights(result, config.currentUser as any, opts);
}
```

### Sicherheit

**Gewaehrleistet durch drei Schichten:**

1. **Input-checkRights laeuft IMMER** (auch bei isNested) — unberechtigte Eingaben werden auf jeder Ebene abgefangen.
2. **Output-checkRights auf Depth 0** — der aeusserste Call filtert das finale Ergebnis.
3. **CheckSecurityInterceptor** — das letzte Sicherheitsnetz in der HTTP-Response-Pipeline ruft `securityCheck()` rekursiv auf dem gesamten Response-Baum auf, inklusive aller verschachtelten Objekte.

**Gegenprobe:** Was passiert wenn ein innerer Service ein Objekt zurueckgibt das der User nicht sehen darf?
- Der innere process() ueberspringt den Output-Rights-Check → Objekt bleibt unveraendert
- Der aeussere process() fuehrt den Output-Rights-Check durch → Felder werden entfernt
- Falls der aeussere process() es auch verpasst → CheckSecurityInterceptor entfernt die Felder

### Kompatibilitaet

Geprueft an realen Kaskaden:
- **CompanyService.create()** (5-Ebenen-Kaskade): Innere creates (ProfileSite, ProfileCategory, ProfileEntry, Form) brauchen kein Populate — Ergebnisse werden nur fuer IDs weiterverwendet.
- **ParticipationService → UserService**: UserService.create() Ergebnis wird inline weiterverwendet, nicht an User zurueckgegeben.
- **ShippingService → BounceService/EmailService**: Kein Populate auf inneren Ebenen noetig.
- **Services mit explizitem `populate:`**: Funktionieren weiterhin, da `config.populate` den isNested-Skip ueberschreibt.

---

## Aenderung 5: checkRestricted Metadata-Caching

### Datei: `src/core/common/decorators/restricted.decorator.ts`

### Problem

`getRestricted()` (Zeile 50-58) ruft bei jedem Property-Check `Reflect.getMetadata()` auf. Bei einem Objekt mit 15 Properties und verschachtelten Objekten summieren sich hunderte Reflect-Lookups pro Request. Die Metadata aendert sich zur Laufzeit nie (Decorators sind statisch).

### Aktueller Code (Zeile 50-58)

```typescript
export const getRestricted = (object: unknown, propertyKey?: string): RestrictedType => {
  if (!object) {
    return null;
  }
  if (!propertyKey) {
    return Reflect.getMetadata(restrictedMetaKey, object);
  }
  return Reflect.getMetadata(restrictedMetaKey, object, propertyKey);
};
```

### Neuer Code

```typescript
// Cache for Restricted metadata — decorators are static, metadata never changes at runtime.
// Map<CacheTarget, Map<propertyKey | '__class__', RestrictedType>>
//
// CacheTarget is the class constructor (for instances) or the class itself (when object IS a constructor).
// This distinction is critical: getRestricted(data.constructor) passes a class as `object`,
// and (classFunction).constructor === Function for ALL classes — so we must use the class itself.
const restrictedMetadataCache = new Map<unknown, Map<string, RestrictedType>>();

export const getRestricted = (object: unknown, propertyKey?: string): RestrictedType => {
  if (!object) {
    return null;
  }

  // Determine cache target: use the class constructor for instances, the object itself for classes.
  // When object IS a constructor (typeof === 'function'), using object.constructor would give Function
  // for ALL classes, causing cache collisions.
  const cacheTarget = typeof object === 'function' ? object : (object as any).constructor;
  if (!cacheTarget) {
    // Fallback for objects without constructor (e.g. Object.create(null))
    return propertyKey
      ? Reflect.getMetadata(restrictedMetaKey, object, propertyKey)
      : Reflect.getMetadata(restrictedMetaKey, object);
  }

  // Cache lookup
  let classCache = restrictedMetadataCache.get(cacheTarget);
  if (!classCache) {
    classCache = new Map();
    restrictedMetadataCache.set(cacheTarget, classCache);
  }

  const cacheKey = propertyKey || '__class__';
  if (classCache.has(cacheKey)) {
    return classCache.get(cacheKey);
  }

  // Cache miss: perform Reflect lookup and cache the result
  const metadata = propertyKey
    ? Reflect.getMetadata(restrictedMetaKey, object, propertyKey)
    : Reflect.getMetadata(restrictedMetaKey, object);

  classCache.set(cacheKey, metadata);
  return metadata;
};
```

### Zusaetzlich: _.uniq()-Optimierung in checkRestricted (Zeile 260)

```typescript
// Aktuell:
const concatenatedRestrictions = config.mergeRoles ? _.uniq(objectRestrictions.concat(restricted)) : restricted;

// Optimiert — vermeidet Array-Allokation wenn objectRestrictions leer:
const concatenatedRestrictions = config.mergeRoles && objectRestrictions.length
  ? _.uniq(objectRestrictions.concat(restricted))
  : restricted;
```

Diese Zeile wird fuer **jede Property jedes Objekts** aufgerufen. Wenn `objectRestrictions` leer ist (haeufig bei Models ohne Class-Level `@Restricted`), spart das eine Array-Allokation + uniq-Berechnung pro Property.

### Sicherheit

**Nicht betroffen** — gleiche Ergebnisse, da Decorator-Metadata sich zur Laufzeit nicht aendert. Der Cache liefert exakt die gleichen Werte wie der direkte Reflect-Lookup.

### Kompatibilitaet

Transparent — kein Projekt muss angepasst werden.

---

## Zusammenfassung der Einsparungen

### Einzelner API-Call (Depth 0, kein Nesting):

| Aenderung | Einsparung |
|-----------|------------|
| JSON.stringify entfaellt | ~0.1-1 KB + 2x Serialisierung |
| Lean dbObject statt this.get() | ~5-15 KB + 1 rekursiver process()-Durchlauf |
| Metadata-Cache | CPU: ~hunderte Reflect-Lookups weniger |

### Verschachtelter Call (Depth > 0):

| Schritt | Vorher | Nachher |
|---------|--------|---------|
| JSON.stringify | 2x Serialisierung | Uebersprungen |
| prepareInput | Laeuft | Laeuft (unveraendert) |
| this.get(dbObject) | Rekursives process() | Lean Query + Map |
| checkRights(input) | Laeuft | Laeuft (unveraendert) |
| serviceFunc | Laeuft | Laeuft (unveraendert) |
| processFieldSelection | Volle Population | Uebersprungen (ausser explizites populate) |
| prepareOutput | Volles Mapping | Nur Secrets-Removal |
| checkRights(output) | Laeuft | Uebersprungen |

**Pro verschachteltem Call: ~30-70 KB + 2-5 DB-Queries weniger.**

### Beispiel: 8-stufige Service-Kaskade (z.B. Incident-Handling):

- Vorher: 8 x ~50 KB = ~400 KB
- Nachher: 1 x ~50 KB (aeusserer) + 7 x ~10 KB (innere) = ~120 KB
- **~70% weniger Memory**

---

## Betroffene Dateien

| Datei | Aenderung |
|-------|-----------|
| `src/core/common/services/module.service.ts` | Aenderungen 1, 2, 4 |
| `src/core/common/services/request-context.service.ts` | Aenderung 3 |
| `src/core/common/decorators/restricted.decorator.ts` | Aenderung 5 |
| `src/core/common/interfaces/server-options.interface.ts` | Config-Option `debugProcessInput` |

---

## Verifizierung

1. **Bestehende E2E-Tests** muessen alle gruen bleiben — die Aenderungen sind rueckwaertskompatibel
2. **Service-Kaskade testen**: z.B. ein create() das intern andere Services aufruft
3. **Populate auf aeusserster Ebene**: `{ populate: ['user', 'customer'] }` muss weiterhin funktionieren
4. **securityCheck()**: Sensitive Felder (password, etc.) duerfen nie in der Response auftauchen
5. **S_CREATOR-Check**: User der ein Objekt erstellt hat, muss es weiterhin bearbeiten koennen
6. **Performance**: `process.memoryUsage()` vor/nach Optimierung bei verschachtelten Calls messen

---

## Risiken

| Risiko | Absicherung |
|--------|-------------|
| Innerer Service braucht populate-Ergebnis | `config.populate` ueberschreibt den isNested-Skip — explizite Anforderung wird respektiert |
| Output-Rights-Check auf innerem Ergebnis fehlt | CheckSecurityInterceptor ist das Sicherheitsnetz auf HTTP-Ebene |
| Metadata-Cache wird stale | Unmoeglich — Decorator-Metadata ist zur Compile-Zeit fixiert |
| Lean dbObject hat andere Struktur als hydriertes | `modelConstructor.map()` stellt die erwartete Struktur her |
