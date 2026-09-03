# Matrice du « Create » — cases rouges

Généré par `node test/test-create-matrix.js --slow` — mesuré sur le harnais en
boucle fermée ([test/harness-loop.js](harness-loop.js)), jamais déduit. Aucune
correction appliquée : ce rapport est une photographie, pas un correctif.

## Compte de la matrice

- 3 × 5 × 4 × 3 = 180 cases brutes
- 144 éliminées par construction (voir en-tête de test-create-matrix.js, E1/E2/E3)
- 36 cases mesurées

## Cases rouges

Aucune — les 36 cases mesurées tiennent les 7 invariants (I1..I7).
## Toutes les cases mesurées

| case | T | M | P | G | verdict |
|---|---|---|---|---|---|
| `t1absentehorslotcreate` | 1 tâche | maîtresse absente | — | Create direct | 🟢 |
| `t1searchhorslotcreate` | 1 tâche | résolue (recherche) | hors lot | Create direct | 🟢 |
| `t1searchmembrecreate` | 1 tâche | résolue (recherche) | membre d’un lot vivant | Create direct | 🟢 |
| `t1searchmembrerowClick` | 1 tâche | résolue (recherche) | membre d’un lot vivant | clic sur une ligne du lot | 🟢 |
| `t1searchmembremasterRowClick` | 1 tâche | résolue (recherche) | membre d’un lot vivant | clic sur la ligne de la maîtresse | 🟢 |
| `t1searchtetecreate` | 1 tâche | résolue (recherche) | tête d’un lot vivant | Create direct | 🟢 |
| `t1searchmembreavancecreate` | 1 tâche | résolue (recherche) | membre, vague suivante déjà lancée | Create direct | 🟢 |
| `t1searchmembreavancerowClick` | 1 tâche | résolue (recherche) | membre, vague suivante déjà lancée | clic sur une ligne du lot | 🟢 |
| `t1searchmembreavancemasterRowClick` | 1 tâche | résolue (recherche) | membre, vague suivante déjà lancée | clic sur la ligne de la maîtresse | 🟢 |
| `t1detacheehorslotcreate` | 1 tâche | résolue puis détachée au clic | hors lot | Create direct | 🟢 |
| `t1designeehorslotcreate` | 1 tâche | désignée au clic sur une autre ligne | hors lot | Create direct | 🟢 |
| `t1ambiguehorslotcreate` | 1 tâche | ambiguë (plusieurs candidates) | — | Create direct | 🟢 |
| `t2aabsentehorslotcreate` | 2 tâches, 1 vague | maîtresse absente | — | Create direct | 🟢 |
| `t2asearchhorslotcreate` | 2 tâches, 1 vague | résolue (recherche) | hors lot | Create direct | 🟢 |
| `t2asearchmembrecreate` | 2 tâches, 1 vague | résolue (recherche) | membre d’un lot vivant | Create direct | 🟢 |
| `t2asearchmembrerowClick` | 2 tâches, 1 vague | résolue (recherche) | membre d’un lot vivant | clic sur une ligne du lot | 🟢 |
| `t2asearchmembremasterRowClick` | 2 tâches, 1 vague | résolue (recherche) | membre d’un lot vivant | clic sur la ligne de la maîtresse | 🟢 |
| `t2asearchtetecreate` | 2 tâches, 1 vague | résolue (recherche) | tête d’un lot vivant | Create direct | 🟢 |
| `t2asearchmembreavancecreate` | 2 tâches, 1 vague | résolue (recherche) | membre, vague suivante déjà lancée | Create direct | 🟢 |
| `t2asearchmembreavancerowClick` | 2 tâches, 1 vague | résolue (recherche) | membre, vague suivante déjà lancée | clic sur une ligne du lot | 🟢 |
| `t2asearchmembreavancemasterRowClick` | 2 tâches, 1 vague | résolue (recherche) | membre, vague suivante déjà lancée | clic sur la ligne de la maîtresse | 🟢 |
| `t2adetacheehorslotcreate` | 2 tâches, 1 vague | résolue puis détachée au clic | hors lot | Create direct | 🟢 |
| `t2adesigneehorslotcreate` | 2 tâches, 1 vague | désignée au clic sur une autre ligne | hors lot | Create direct | 🟢 |
| `t2aambiguehorslotcreate` | 2 tâches, 1 vague | ambiguë (plusieurs candidates) | — | Create direct | 🟢 |
| `t2babsentehorslotcreate` | 2 tâches, 2 vagues | maîtresse absente | — | Create direct | 🟢 |
| `t2bsearchhorslotcreate` | 2 tâches, 2 vagues | résolue (recherche) | hors lot | Create direct | 🟢 |
| `t2bsearchmembrecreate` | 2 tâches, 2 vagues | résolue (recherche) | membre d’un lot vivant | Create direct | 🟢 |
| `t2bsearchmembrerowClick` | 2 tâches, 2 vagues | résolue (recherche) | membre d’un lot vivant | clic sur une ligne du lot | 🟢 |
| `t2bsearchmembremasterRowClick` | 2 tâches, 2 vagues | résolue (recherche) | membre d’un lot vivant | clic sur la ligne de la maîtresse | 🟢 |
| `t2bsearchtetecreate` | 2 tâches, 2 vagues | résolue (recherche) | tête d’un lot vivant | Create direct | 🟢 |
| `t2bsearchmembreavancecreate` | 2 tâches, 2 vagues | résolue (recherche) | membre, vague suivante déjà lancée | Create direct | 🟢 |
| `t2bsearchmembreavancerowClick` | 2 tâches, 2 vagues | résolue (recherche) | membre, vague suivante déjà lancée | clic sur une ligne du lot | 🟢 |
| `t2bsearchmembreavancemasterRowClick` | 2 tâches, 2 vagues | résolue (recherche) | membre, vague suivante déjà lancée | clic sur la ligne de la maîtresse | 🟢 |
| `t2bdetacheehorslotcreate` | 2 tâches, 2 vagues | résolue puis détachée au clic | hors lot | Create direct | 🟢 |
| `t2bdesigneehorslotcreate` | 2 tâches, 2 vagues | désignée au clic sur une autre ligne | hors lot | Create direct | 🟢 |
| `t2bambiguehorslotcreate` | 2 tâches, 2 vagues | ambiguë (plusieurs candidates) | — | Create direct | 🟢 |

